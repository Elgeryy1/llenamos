// Genera el histórico de un restaurante clonando por SQL los documentos reales que creó la API (plantillas), con fechas
// repartidas en los últimos N días. Cada tabla se rellena por sus columnas indexadas y su documento JSON; no pasa por la API
// (el histórico de meses no se puede crear con operaciones reales, que fijan la hora actual).
export interface Volumes { days: number; sessionsWeekday: number; sessionsWeekend: number; reservationsWeekday: number; reservationsWeekend: number; customers: number }
export const defaultVolumes: Volumes = { days: Number(process.env.CARGA_DIAS ?? 120), sessionsWeekday: 45, sessionsWeekend: 80, reservationsWeekday: 25, reservationsWeekend: 45, customers: 1500 }

export function historySql(rid: string, loc: string, templateSession: string, v: Volumes = defaultVolumes): string {
  return `
DO $$
DECLARE
  rid constant text := '${rid}'; loc constant text := '${loc}'; tsid constant text := '${templateSession}';
  ts record; tord record; tbill record; tpart record; tpay record; tcash record; tres record; tcust record; tl record;
  d int; k int; n int; base_ms bigint; sid text; oid text; bid text; pid text; payid text; csid text; lid text; rsid text; cust text;
  new_lines text[]; day_start timestamptz; st text;
BEGIN
  SELECT * INTO ts FROM llenamos.sala_table_sessions WHERE restaurant_id=rid AND location_id=loc AND id=tsid;
  SELECT * INTO tord FROM llenamos.sala_orders WHERE restaurant_id=rid AND location_id=loc AND session_id=tsid LIMIT 1;
  SELECT * INTO tbill FROM llenamos.pos_bills WHERE restaurant_id=rid AND location_id=loc AND target_id=tsid;
  SELECT * INTO tpart FROM llenamos.pos_bill_parts WHERE restaurant_id=rid AND location_id=loc AND bill_id=tbill.id LIMIT 1;
  SELECT * INTO tpay FROM llenamos.pos_payments WHERE restaurant_id=rid AND location_id=loc AND bill_id=tbill.id LIMIT 1;
  SELECT * INTO tcash FROM llenamos.pos_cash_sessions WHERE restaurant_id=rid AND location_id=loc LIMIT 1;
  SELECT * INTO tres FROM llenamos.reservations WHERE restaurant_id=rid AND location_id=loc LIMIT 1;
  SELECT * INTO tcust FROM llenamos.customers WHERE restaurant_id=rid LIMIT 1;
  IF ts.id IS NULL OR tbill.id IS NULL OR tpay.id IS NULL OR tres.id IS NULL OR tcust.id IS NULL THEN RAISE EXCEPTION 'faltan plantillas'; END IF;

  -- Clientes
  INSERT INTO llenamos.customers(restaurant_id,id,data,created_at,updated_at)
    SELECT rid, substr(md5(rid||'c'||g),1,20), jsonb_set(jsonb_set(tcust.data,'{name}',to_jsonb('Cliente '||g)),'{phone}',to_jsonb('+346'||lpad((10000000+g)::text,8,'0'))),
      now()-(random()*${v.days}||' days')::interval, now()
    FROM generate_series(1,${v.customers}) g ON CONFLICT DO NOTHING;

  FOR d IN 1..${v.days} LOOP
    day_start := date_trunc('day', now() AT TIME ZONE 'Europe/Madrid')::timestamp AT TIME ZONE 'Europe/Madrid' - (d||' days')::interval;
    n := CASE WHEN extract(isodow from day_start) >= 5 THEN ${v.sessionsWeekend} ELSE ${v.sessionsWeekday} END;
    csid := md5(rid||'cash'||d);
    INSERT INTO llenamos.pos_cash_sessions(restaurant_id,location_id,id,register_id,status,opened_at,data)
      VALUES(rid,loc,csid,'caja-h'||d,'closed',day_start+interval '12 hours',
        jsonb_set(jsonb_set(tcash.data,'{openedAt}',to_jsonb((extract(epoch from day_start+interval '12 hours')*1000)::bigint)),'{registerId}',to_jsonb('caja-h'||d))) ON CONFLICT DO NOTHING;
    FOR k IN 1..n LOOP
      base_ms := (extract(epoch from day_start + interval '12 hours' + (k * 8) * interval '1 minute')*1000)::bigint;
      sid := 'h'||substr(md5(rid||d||'s'||k),1,19); oid := 'o'||substr(md5(sid),1,19); bid := md5(sid||'b'); pid := md5(sid||'p'); payid := md5(sid||'y');
      new_lines := ARRAY[]::text[];
      FOR tl IN SELECT * FROM llenamos.sala_order_lines WHERE restaurant_id=rid AND location_id=loc AND session_id=tsid LOOP
        lid := 'l'||substr(md5(sid||tl.id),1,19); new_lines := new_lines || lid;
        INSERT INTO llenamos.sala_order_lines(restaurant_id,location_id,id,doc,created_at,updated_at)
          VALUES(rid,loc,lid, tl.doc || jsonb_build_object('sessionId',sid,'orderId',oid,'placedAt',base_ms,'servedAt',base_ms+900000), to_timestamp(base_ms/1000.0), to_timestamp(base_ms/1000.0));
      END LOOP;
      INSERT INTO llenamos.sala_table_sessions(restaurant_id,location_id,id,doc,created_at,updated_at)
        VALUES(rid,loc,sid, ts.doc || jsonb_build_object('openedAt',base_ms,'closedAt',base_ms+3600000,'label','T'||(1+k%12),'tableIds',jsonb_build_array('t'||(1+k%12))), to_timestamp(base_ms/1000.0), to_timestamp((base_ms+3600000)/1000.0));
      INSERT INTO llenamos.sala_orders(restaurant_id,location_id,id,doc,created_at,updated_at)
        VALUES(rid,loc,oid, tord.doc || jsonb_build_object('sessionId',sid,'placedAt',base_ms,'lineIds',to_jsonb(new_lines)), to_timestamp(base_ms/1000.0), to_timestamp(base_ms/1000.0));
      INSERT INTO llenamos.pos_bills(restaurant_id,location_id,id,target_kind,target_id,status,revision,opened_at,data)
        VALUES(rid,loc,bid,'session',sid,'settled',tbill.revision,to_timestamp(base_ms/1000.0), jsonb_set(tbill.data || jsonb_build_object('openedAt',base_ms+3000000,'settledAt',base_ms+3100000),'{target,id}',to_jsonb(sid)));
      INSERT INTO llenamos.pos_bill_parts(restaurant_id,location_id,id,bill_id,data) VALUES(rid,loc,pid,bid,tpart.data || jsonb_build_object('billId',bid));
      INSERT INTO llenamos.pos_payments(restaurant_id,location_id,id,bill_id,part_id,cash_session_id,kind,status,method,at,data)
        VALUES(rid,loc,payid,bid,pid,csid,'charge','succeeded',tpay.method,to_timestamp((base_ms+3100000)/1000.0), tpay.data || jsonb_build_object('billId',bid,'partId',pid,'cashSessionId',csid,'at',base_ms+3100000,'requestId','h'||payid));
      INSERT INTO llenamos.events(restaurant_id,location_id,topic,entity_id,payload,occurred_at)
        VALUES(rid,loc,'sala.sesion',sid,'{}',to_timestamp(base_ms/1000.0)),(rid,loc,'caja.cobro',bid,'{}',to_timestamp((base_ms+3100000)/1000.0));
    END LOOP;
    -- Reservas del día
    FOR k IN 1..(CASE WHEN extract(isodow from day_start) >= 5 THEN ${v.reservationsWeekend} ELSE ${v.reservationsWeekday} END) LOOP
      rsid := 'h'||substr(md5(rid||d||'r'||k),1,19);
      st := CASE WHEN k%13=0 THEN 'cancelled' WHEN k%17=0 THEN 'no_show' ELSE 'finished' END;
      cust := substr(md5(rid||'c'||(1+(d*37+k*11)%${v.customers})),1,20);
      base_ms := (extract(epoch from day_start + interval '13 hours' + (k % 20) * interval '30 minutes')*1000)::bigint;
      INSERT INTO llenamos.reservations(restaurant_id,location_id,id,customer_id,reference,start_at,status,table_ids,manage_token_hash,data,created_at,updated_at)
        VALUES(rid,loc,rsid,cust,translate(upper(substr(md5(rsid),1,6)),'01','23'),to_timestamp(base_ms/1000.0),
          st, ARRAY['t'||(1+k%12)], md5(rsid)||md5(rsid||'x'),
          tres.data || jsonb_build_object('startAt',base_ms,'reference',translate(upper(substr(md5(rsid),1,6)),'01','23'),'customerId',cust,'guestName','Cliente '||k,'partySize',2+k%5,'status',st,'manageTokenHash',md5(rsid)||md5(rsid||'x')),
          to_timestamp(base_ms/1000.0)-interval '2 days', to_timestamp(base_ms/1000.0))
        ON CONFLICT DO NOTHING;
    END LOOP;
    INSERT INTO llenamos.events(restaurant_id,location_id,topic,entity_id,payload,occurred_at)
      SELECT rid,loc,'reservas.reserva',id,'{}',start_at FROM llenamos.reservations WHERE restaurant_id=rid AND location_id=loc AND start_at>=day_start AND start_at<day_start+interval '1 day' AND id LIKE 'h%';
  END LOOP;
END $$;
ANALYZE llenamos.reservations, llenamos.sala_table_sessions, llenamos.sala_orders, llenamos.sala_order_lines, llenamos.pos_bills, llenamos.pos_bill_parts, llenamos.pos_payments, llenamos.events, llenamos.customers;
`
}
