importScripts('/sw-avisos.js')
/* Carcasa pública de recuperación. Nunca guarda HTML autenticado, respuestas de API ni tokens. */
const SHELL = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Llenamos · sin conexión</title><style>body{margin:0;background:#131209;color:#f4f1ea;font:16px system-ui}main{max-width:720px;margin:8vh auto;padding:24px}section{background:#1b1914;border:1px solid #ffffff18;border-radius:14px;padding:20px;margin:20px 0}h1{font-size:32px}p{line-height:1.6}button{background:#f0a35e;color:#1a1408;border:0;border-radius:8px;min-height:48px;padding:12px 18px;font:inherit}small{color:#d6d2c8}</style><main><small>Llenamos · recuperación del dispositivo</small><h1>Sin conexión</h1><p>La cola permanece guardada para la misma cuenta. Los pedidos pendientes aún no han llegado a cocina y los cambios de cocina aún no han llegado a sala.</p><section aria-live="polite" id="state">Consultando el almacenamiento local…</section><p>Para seguir editando, conserva abierta la pantalla del servicio preparada antes del corte. Esta carcasa permite comprobar pendientes después de recargar. Al volver internet se abrirá el panel para recuperar y sincronizar.</p><p>Sin conexión no se puede cobrar con tarjeta, confirmar cobros, emitir facturas fiscales ni cerrar la caja. Comunica el servicio de palabra o en papel.</p><button onclick="navigator.serviceWorker.controller?.postMessage({type:'llenamos:network',offline:!navigator.onLine});location.reload()">Volver a comprobar la conexión</button><p><button id="lock">Bloquear la vista local</button></p></main><script>
const state=document.getElementById('state');
const label={queued:'Pendiente de sincronizar',sending:'Respuesta por recuperar',uncertain:'Respuesta por recuperar',retry:'Pendiente de reintento',conflict:'Conflicto pendiente de revisión',rejected:'Envío bloqueado'};
async function read(){
 const active=localStorage.getItem('llenamos:offline:active');
 if(!active){state.textContent='La vista local está bloqueada. Entra con conexión con la misma cuenta para recuperar sus pendientes.';return}
 try{
  const scope=JSON.parse(active).scope;
  const db=await new Promise((ok,no)=>{const r=indexedDB.open('llenamos:sin-conexion:1',1);r.onsuccess=()=>ok(r.result);r.onerror=no});
  if(!db.objectStoreNames.contains('spaces')){state.textContent='No hay servicio preparado en este dispositivo.';return}
  const spaces=await new Promise((ok,no)=>{const r=db.transaction('spaces').objectStore('spaces').getAll();r.onsuccess=()=>ok(r.result);r.onerror=no});
  if(active!==localStorage.getItem('llenamos:offline:active'))return read();
  const entries=spaces.flatMap(s=>s.entries).filter(e=>e.command.actorUid===scope.actorUid&&e.command.restaurantId===scope.restaurantId&&e.command.locationId===scope.locationId&&e.command.deviceId===scope.deviceId&&!['applied','discarded'].includes(e.state));
  const notes=spaces.flatMap(s=>s.cash).filter(n=>n.actorUid===scope.actorUid&&n.restaurantId===scope.restaurantId&&n.locationId===scope.locationId&&n.deviceId===scope.deviceId&&n.status==='pending_review');
  state.replaceChildren();const p=document.createElement('p');p.textContent='Cambios pendientes: '+entries.length+'. Anotaciones de efectivo por revisar: '+notes.length+'.';state.append(p);
  entries.forEach(e=>{const p=document.createElement('p');p.textContent='Cambio '+e.command.sequence+' · '+(label[e.state]||'Pendiente');state.append(p)});
  db.close();
 }catch{state.textContent='No se puede leer el almacenamiento local. No borres los datos del navegador mientras haya envíos pendientes.'}
}
document.getElementById('lock').onclick=()=>{localStorage.removeItem('llenamos:offline:active');read()};
window.addEventListener('storage',read);window.addEventListener('online',()=>{navigator.serviceWorker.controller?.postMessage({type:'llenamos:network',offline:false});location.reload()});read();
</script></html>`
let networkOffline = false
self.addEventListener('message', event => { if (event.data?.type === 'llenamos:network' && typeof event.data.offline === 'boolean') networkOffline = event.data.offline })
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || event.request.mode !== 'navigate' || !url.pathname.startsWith('/panel/')) return
  if (networkOffline) { event.respondWith(new Response(SHELL, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })); return }
  event.respondWith(fetch(event.request, { cache: 'no-store' }).catch(() => new Response(SHELL, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })))
})
