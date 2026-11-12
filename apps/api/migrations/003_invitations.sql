-- La API sólo recibe procedimientos de identidad estrechos, nunca UPDATE sobre identidades.
ALTER TABLE llenamos.memberships ADD COLUMN invitation_pending boolean NOT NULL DEFAULT false;
GRANT EXECUTE ON FUNCTION llenamos.actor_uid(),llenamos.is_platform() TO llenamos_migrator;
CREATE TABLE llenamos.account_invitations (
 id char(64) PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
 uid text NOT NULL REFERENCES llenamos.identities(uid),
 email varchar(254) NOT NULL, display_name varchar(80) NOT NULL,
 role text NOT NULL CHECK(role IN ('owner','manager','waiter','kitchen','bar')),
 invited_by text NOT NULL, kind text NOT NULL CHECK(kind IN ('owner','member')),
 state text NOT NULL CHECK(state IN ('pending','sent','accepting','accepted','cancelled')),
 token_hash char(64), token_ciphertext jsonb, expires_at timestamptz NOT NULL,
 lease_id uuid, lease_until timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(restaurant_id,uid)
);
ALTER TABLE llenamos.account_invitations OWNER TO llenamos_migrator;
ALTER TABLE llenamos.account_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.account_invitations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON llenamos.account_invitations FROM PUBLIC,llenamos_app;
-- FORCE RLS sigue activo: exclusivamente los procedimientos SECURITY DEFINER ven estos datos.
CREATE POLICY invitation_custody ON llenamos.account_invitations TO llenamos_migrator USING(true) WITH CHECK(true);
CREATE POLICY invitation_identity_custody ON llenamos.identities TO llenamos_migrator USING(true) WITH CHECK(true);
CREATE POLICY invitation_member_custody ON llenamos.memberships TO llenamos_migrator USING(true) WITH CHECK(true);
CREATE POLICY invitation_restaurant_custody ON llenamos.restaurants TO llenamos_migrator USING(true) WITH CHECK(true);
CREATE POLICY invitation_platform_custody ON llenamos.platform_restaurants TO llenamos_migrator USING(true) WITH CHECK(true);

CREATE FUNCTION llenamos.invitation_actor(rid text,target_role text,mode text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE actor text:=llenamos.actor_uid(); actor_role text;
BEGIN
 IF NOT EXISTS(SELECT FROM llenamos.identities WHERE uid=actor AND NOT locked AND NOT disabled) THEN RAISE EXCEPTION 'invitation_denied'; END IF;
 IF mode='owner' THEN
  IF NOT llenamos.is_platform() OR NOT EXISTS(SELECT FROM llenamos.identities WHERE uid=actor AND platform_operator) THEN RAISE EXCEPTION 'invitation_denied'; END IF;
 ELSE
  IF llenamos.is_platform() OR EXISTS(SELECT FROM llenamos.identities WHERE uid=actor AND platform_operator) THEN RAISE EXCEPTION 'invitation_denied'; END IF;
  SELECT role INTO actor_role FROM llenamos.memberships WHERE restaurant_id=rid AND uid=actor AND active;
  IF actor_role IS NULL OR actor_role NOT IN ('owner','manager') OR (target_role IN ('owner','manager') AND actor_role<>'owner') THEN RAISE EXCEPTION 'invitation_denied'; END IF;
 END IF;
END $$;

CREATE FUNCTION llenamos.invitation_member_preflight(rid text,mail text,target_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE target llenamos.memberships; used integer; cap integer; service_ok boolean;
BEGIN
 PERFORM llenamos.invitation_actor(rid,target_role,'member');
 PERFORM id FROM llenamos.restaurants WHERE id=rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'invitation_invalid'; END IF;
 SELECT * INTO target FROM llenamos.memberships WHERE restaurant_id=rid AND email=mail LIMIT 1;
 IF target.uid=llenamos.actor_uid() THEN RAISE EXCEPTION 'invitation_invalid'; END IF;
 IF target.role='owner' THEN PERFORM llenamos.invitation_actor(rid,'owner','member'); END IF;
 IF target.active THEN RAISE EXCEPTION 'invitation_already_exists'; END IF;
 IF target.invitation_pending THEN RETURN; END IF;
 SELECT u.members,(p.definition->'limits'->>'members')::integer,
 ((s.status='trialing' AND s.trial_ends_at>now()) OR (s.status='active' AND s.period_ends_at>now()) OR (s.status='past_due' AND s.grace_ends_at>now()))
 INTO used,cap,service_ok FROM llenamos.platform_usage u JOIN llenamos.platform_subscriptions s USING(restaurant_id)
 JOIN llenamos.platform_plans p ON p.id=s.plan_id AND p.version=s.plan_version WHERE u.restaurant_id=rid;
 IF used IS NULL OR NOT coalesce(service_ok,false) OR (cap IS NOT NULL AND used>=cap) THEN RAISE EXCEPTION 'invitation_capacity'; END IF;
END $$;

CREATE FUNCTION llenamos.invitation_prepare(p_id text,rid text,target_uid text,mail text,display text,target_role text,locations text[],mode text,hash text,cipher jsonb,expires timestamptz,version text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE previous llenamos.account_invitations; target llenamos.memberships;
BEGIN
 PERFORM llenamos.invitation_actor(rid,target_role,mode);
 IF target_uid=llenamos.actor_uid() OR target_role NOT IN ('owner','manager','waiter','kitchen','bar') OR p_id !~ '^[a-f0-9]{64}$' OR hash !~ '^[a-f0-9]{64}$' OR version !~ '^[a-f0-9]{32}$'
  OR length(mail)>254 OR length(display) NOT BETWEEN 1 AND 80 OR expires<=now() OR expires>now()+interval '25 hours' THEN RAISE EXCEPTION 'invitation_invalid'; END IF;
 PERFORM id FROM llenamos.restaurants WHERE id=rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'invitation_invalid'; END IF;
 IF mode='owner' AND (target_role<>'owner' OR NOT EXISTS(SELECT FROM llenamos.platform_restaurants WHERE restaurant_id=rid AND owner_email=mail)) THEN RAISE EXCEPTION 'invitation_denied'; END IF;
 INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES(target_uid,version,now(),true) ON CONFLICT(uid) DO NOTHING;
 IF EXISTS(SELECT FROM llenamos.identities WHERE uid=target_uid AND (platform_operator OR disabled)) THEN RAISE EXCEPTION 'invitation_denied'; END IF;
 SELECT * INTO target FROM llenamos.memberships WHERE restaurant_id=rid AND uid=target_uid FOR UPDATE;
 IF target.active OR (mode='member' AND target.role='owner' AND NOT EXISTS(SELECT FROM llenamos.memberships WHERE restaurant_id=rid AND uid=llenamos.actor_uid() AND active AND role='owner')) THEN RAISE EXCEPTION 'invitation_already_exists'; END IF;
 SELECT * INTO previous FROM llenamos.account_invitations WHERE restaurant_id=rid AND uid=target_uid FOR UPDATE;
 IF previous.state='accepting' AND previous.lease_until>now() THEN RAISE EXCEPTION 'invitation_busy'; END IF;
 -- El alta administrativa ya reserva el primer propietario en 002; personal se reserva aquí.
 IF mode='member' AND NOT coalesce(target.invitation_pending,false) THEN PERFORM llenamos.invitation_member_capacity(rid,1); END IF;
 INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email,location_ids,invitation_pending)
 VALUES(rid,target_uid,target_role,false,display,mail,locations,true)
 ON CONFLICT(restaurant_id,uid) DO UPDATE SET role=EXCLUDED.role,active=false,display_name=EXCLUDED.display_name,email=EXCLUDED.email,location_ids=EXCLUDED.location_ids,invitation_pending=true;
 IF previous.state IN ('pending','sent') AND previous.role=target_role AND previous.invited_by=llenamos.actor_uid() AND previous.expires_at>now() AND previous.token_ciphertext IS NOT NULL THEN RETURN previous.id; END IF;
 INSERT INTO llenamos.account_invitations(id,restaurant_id,uid,email,display_name,role,invited_by,kind,state,token_hash,token_ciphertext,expires_at)
 VALUES(p_id,rid,target_uid,mail,display,target_role,llenamos.actor_uid(),mode,'pending',hash,cipher,expires)
 ON CONFLICT(restaurant_id,uid) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name,role=EXCLUDED.role,invited_by=EXCLUDED.invited_by,kind=EXCLUDED.kind,state='pending',token_hash=EXCLUDED.token_hash,token_ciphertext=EXCLUDED.token_ciphertext,expires_at=EXCLUDED.expires_at,lease_id=NULL,lease_until=NULL,updated_at=now();
 RETURN p_id;
END $$;

CREATE FUNCTION llenamos.invitation_delivery(p_id text) RETURNS TABLE(email text,token_ciphertext jsonb,state text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
 SELECT i.email::text,i.token_ciphertext,i.state FROM llenamos.account_invitations i WHERE i.id=p_id AND i.state IN ('pending','sent') AND i.expires_at>now()
$$;
CREATE FUNCTION llenamos.invitation_mark_sent(p_id text,hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
BEGIN
 UPDATE llenamos.account_invitations SET state='sent',updated_at=now() WHERE id=p_id AND token_hash=hash AND state IN ('pending','sent') AND expires_at>now();
 RETURN FOUND;
END
$$;
CREATE FUNCTION llenamos.invitation_owner_id(rid text,mail text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
 SELECT id::text FROM llenamos.account_invitations WHERE restaurant_id=rid AND email=mail AND kind='owner'
$$;
CREATE FUNCTION llenamos.invitation_owner_pending(rid text,mail text)
RETURNS TABLE(uid text,email text,display_name text,location_ids text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
BEGIN
 PERFORM llenamos.invitation_actor(rid,'owner','owner');
 RETURN QUERY SELECT m.uid,m.email::text,m.display_name::text,m.location_ids FROM llenamos.memberships m
 JOIN llenamos.platform_restaurants p ON p.restaurant_id=m.restaurant_id
 WHERE m.restaurant_id=rid AND m.email=mail AND p.owner_email=mail AND m.role='owner' AND NOT m.active AND m.invitation_pending;
END $$;
CREATE FUNCTION llenamos.invitation_lookup(p_id text,hash text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
 SELECT uid FROM llenamos.account_invitations WHERE id=p_id AND token_hash=hash AND expires_at>now() AND state IN ('pending','sent','accepting')
$$;
CREATE FUNCTION llenamos.invitation_begin(p_id text,hash text,lease uuid,version text,lease_ms integer)
RETURNS TABLE(uid text,email text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE i llenamos.account_invitations; m llenamos.memberships;
BEGIN
 SELECT * INTO i FROM llenamos.account_invitations WHERE id=p_id FOR UPDATE;
 IF i.id IS NULL OR i.token_hash IS DISTINCT FROM hash OR i.expires_at<=now() OR i.state NOT IN ('pending','sent','accepting') OR (i.state='accepting' AND i.lease_until>now()) OR version !~ '^[a-f0-9]{32}$' OR lease_ms NOT BETWEEN 100 AND 120000 THEN RAISE EXCEPTION 'invitation_invalid'; END IF;
 SELECT * INTO m FROM llenamos.memberships WHERE restaurant_id=i.restaurant_id AND memberships.uid=i.uid FOR UPDATE;
 IF m.active OR NOT m.invitation_pending OR m.role IS DISTINCT FROM i.role THEN RAISE EXCEPTION 'invitation_invalid'; END IF;
 IF i.kind='member' AND NOT EXISTS(SELECT FROM llenamos.memberships actor WHERE actor.restaurant_id=i.restaurant_id AND actor.uid=i.invited_by AND actor.active AND (actor.role='owner' OR (actor.role='manager' AND i.role NOT IN ('owner','manager')))) THEN RAISE EXCEPTION 'invitation_denied'; END IF;
 IF i.kind='owner' AND NOT EXISTS(SELECT FROM llenamos.identities WHERE identities.uid=i.invited_by AND platform_operator AND NOT disabled AND NOT locked) THEN RAISE EXCEPTION 'invitation_denied'; END IF;
 IF EXISTS(SELECT FROM llenamos.identities WHERE identities.uid=i.uid AND (platform_operator OR disabled)) THEN RAISE EXCEPTION 'invitation_denied'; END IF;
 UPDATE llenamos.identities SET locked=true,session_version=version WHERE identities.uid=i.uid;
 UPDATE llenamos.account_invitations SET state='accepting',lease_id=lease,lease_until=now()+lease_ms*interval '1 millisecond',updated_at=now() WHERE id=p_id;
 RETURN QUERY SELECT i.uid,i.email::text;
END $$;
CREATE FUNCTION llenamos.invitation_finish(p_id text,lease uuid,version text,valid_after timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE i llenamos.account_invitations;
BEGIN
 SELECT * INTO i FROM llenamos.account_invitations WHERE id=p_id FOR UPDATE;
 IF i.state<>'accepting' OR i.lease_id IS DISTINCT FROM lease OR NOT EXISTS(SELECT FROM llenamos.identities WHERE uid=i.uid AND locked AND NOT disabled AND NOT platform_operator AND session_version=version)
 OR NOT EXISTS(SELECT FROM llenamos.memberships WHERE restaurant_id=i.restaurant_id AND uid=i.uid AND NOT active AND invitation_pending AND role=i.role) THEN RAISE EXCEPTION 'invitation_invalid'; END IF;
 IF i.kind='member' AND NOT EXISTS(SELECT FROM llenamos.memberships WHERE restaurant_id=i.restaurant_id AND uid=i.invited_by AND active AND (role='owner' OR (role='manager' AND i.role NOT IN ('owner','manager')))) THEN RAISE EXCEPTION 'invitation_denied'; END IF;
 IF i.kind='owner' AND NOT EXISTS(SELECT FROM llenamos.identities WHERE uid=i.invited_by AND platform_operator AND NOT disabled AND NOT locked) THEN RAISE EXCEPTION 'invitation_denied'; END IF;
 UPDATE llenamos.memberships SET active=true,invitation_pending=false WHERE restaurant_id=i.restaurant_id AND uid=i.uid;
 UPDATE llenamos.identities SET locked=false,tokens_valid_after=valid_after WHERE uid=i.uid AND session_version=version;
 UPDATE llenamos.account_invitations SET state='accepted',token_hash=NULL,token_ciphertext=NULL,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=p_id;
END $$;

CREATE FUNCTION llenamos.invitation_change_member(rid text,target_uid text,new_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE target llenamos.memberships;
BEGIN
 IF target_uid=llenamos.actor_uid() THEN RAISE EXCEPTION 'invitation_invalid'; END IF;
 PERFORM id FROM llenamos.restaurants WHERE id=rid FOR UPDATE;
 SELECT * INTO target FROM llenamos.memberships WHERE restaurant_id=rid AND uid=target_uid FOR UPDATE;
 IF target.uid IS NULL THEN RAISE EXCEPTION 'invitation_denied'; END IF;
 PERFORM llenamos.invitation_actor(rid,CASE WHEN target.role='owner' THEN 'owner' ELSE coalesce(new_role,target.role) END,'member');
 IF new_role IS NOT NULL AND new_role NOT IN ('owner','manager','waiter','kitchen','bar') THEN RAISE EXCEPTION 'invitation_invalid'; END IF;
 IF target.role='owner' AND target.active AND (new_role IS NULL OR new_role<>'owner') AND (SELECT count(*) FROM llenamos.memberships WHERE restaurant_id=rid AND active AND role='owner')<=1 THEN RAISE EXCEPTION 'invitation_last_owner'; END IF;
 IF new_role IS NULL THEN
  IF target.active OR target.invitation_pending THEN PERFORM llenamos.invitation_member_capacity(rid,-1); END IF;
  UPDATE llenamos.memberships SET active=false,invitation_pending=false WHERE restaurant_id=rid AND uid=target_uid;
  UPDATE llenamos.account_invitations SET state='cancelled',token_hash=NULL,token_ciphertext=NULL,lease_id=NULL,lease_until=NULL WHERE restaurant_id=rid AND uid=target_uid;
 ELSE
  UPDATE llenamos.memberships SET role=new_role WHERE restaurant_id=rid AND uid=target_uid;
  IF target.invitation_pending THEN
   UPDATE llenamos.account_invitations SET state='cancelled',token_hash=NULL,token_ciphertext=NULL WHERE restaurant_id=rid AND uid=target_uid;
  END IF;
 END IF;
END $$;

-- Nada de PUBLIC: tampoco se exponen helpers internos al proceso HTTP.
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='llenamos' AND p.proname LIKE 'invitation_%' LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO llenamos_migrator',f);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  IF f::text NOT LIKE '%invitation_actor(%' AND f::text NOT LIKE '%invitation_member_capacity(%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO llenamos_app',f); END IF;
 END LOOP;
END $$;
