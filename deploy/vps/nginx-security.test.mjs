// Ejecutar con Docker Linux disponible: node deploy/vps/nginx-security.test.mjs
// Crea únicamente contenedores/red temporales propios. No toca servicios ni redes existentes.
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const prefix = `llenamos-proxy-test-${process.pid}`
const network = `${prefix}-edge`, gateway = `${prefix}-gateway`, upstream = `${prefix}-web`
const nginx = 'nginxinc/nginx-unprivileged:stable-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03'
const node = 'node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d'
const config = fileURLToPath(new URL('./nginx.conf', import.meta.url))
const containers = []
let madeNetwork = false
try {
  // Si existe una ruta Docker incompatible, Docker rechaza crear esta red y no se modifica ninguna.
  docker('network', 'create', '--subnet', '172.30.42.0/28', network); madeNetwork = true
  docker('run', '-d', '--name', upstream, '--network', network, '--ip', '172.30.42.5', '--network-alias', 'web', '--network-alias', 'api', node,
    'node', '-e', `const http=require('node:http');const handler=(q,r)=>{r.setHeader('Cache-Control','public,max-age=999');r.end(JSON.stringify({path:q.url,ip:q.headers['x-real-ip'],xff:q.headers['x-forwarded-for'],scheme:q.headers['x-forwarded-proto']}))};http.createServer(handler).listen(3000,'0.0.0.0');http.createServer(handler).listen(3100,'0.0.0.0')`)
  containers.push(upstream)
  docker('run', '-d', '--name', gateway, '--network', network, '--ip', '172.30.42.3', '--network-alias', 'gateway',
    '-p', '127.0.0.1::8081', '-v', `${config}:/etc/nginx/conf.d/default.conf:ro`, nginx)
  containers.push(gateway)
  const port = docker('port', gateway, '8081/tcp').split(':').at(-1)
  let local
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      local = await fetch(`http://127.0.0.1:${port}/recibo/path_secret?t=query_secret`, {
        headers: { 'CF-Connecting-IP': '8.8.8.8', 'X-Forwarded-For': '9.9.9.9', 'X-Forwarded-Proto': 'https', Referer: 'https://example.test/referer_secret' },
      })
      if (local.status === 200) break
    } catch { /* El arranque aún no ha terminado. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(local?.status, 200, 'gateway no ha arrancado')
  const forwarded = await local.json()
  assert.notEqual(forwarded.ip, '8.8.8.8', 'un cliente de loopback no puede elegir la IP verificada')
  assert.equal(forwarded.xff, forwarded.ip, 'se reemplaza XFF en vez de conservar valores del cliente')
  assert.equal(forwarded.scheme, 'http', 'un cliente directo no puede fingir HTTPS externo')
  assert.equal(local.headers.get('strict-transport-security'), null)
  assert.match(local.headers.get('cache-control'), /no-store/)
  assert.equal(local.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(local.headers.get('x-frame-options'), 'DENY')

  const clientScript = `
    const assert=require('node:assert/strict');
    (async()=>{
      const h={'CF-Connecting-IP':'203.0.113.7','X-Forwarded-Proto':'https'};
      const receipt=await fetch('http://gateway:8081/recibo/path_secret?t=query_secret',{headers:{...h,Referer:'https://example.test/referer_secret'}});
      assert.equal(receipt.status,200);assert.equal((await receipt.json()).ip,'203.0.113.7');
      assert.equal(receipt.headers.get('strict-transport-security'),'max-age=31536000');
      assert.match(receipt.headers.get('cache-control'),/no-store/);
      const api=await fetch('http://gateway:8081/api/v1/session',{headers:h});
      assert.equal(api.status,200);assert.equal((await api.json()).path,'/v1/session');
      assert.match(api.headers.get('cache-control'),/no-store/);
      const big=new Uint8Array(1024*1024), hook=new Uint8Array(100*1024);
      assert.equal((await fetch('http://gateway:8081/api/v1/operations/x',{method:'POST',headers:h,body:big})).status,413,'las operaciones JSON siguen limitadas a 64 KB');
      assert.equal((await fetch('http://gateway:8081/api/v1/restaurants/rest1/files?purpose=carta_foto',{method:'PUT',headers:h,body:big})).status,200,'la subida de archivos admite hasta 9 MB');
      assert.equal((await fetch('http://gateway:8081/api/v1/restaurants/rest1/files?purpose=carta_foto',{method:'PUT',headers:h,body:new Uint8Array(10*1024*1024)})).status,413);
      assert.equal((await fetch('http://gateway:8081/api/v1/webhooks/stripe/rest1',{method:'POST',headers:h,body:hook})).status,200);
      assert.equal((await fetch('http://gateway:8081/api/v1/webhooks/stripe/rest1',{method:'POST',headers:h,body:new Uint8Array(300*1024)})).status,413);
      const photo=await fetch('http://gateway:8081/api/v1/public/files/rest1/0a0b0c0d-1111-2222-3333-444455556666',{headers:h});
      assert.match(photo.headers.get('cache-control'),/public, max-age=300/);
      const widget=await fetch('http://gateway:8081/widget/demo',{headers:h});
      assert.equal(widget.headers.get('x-frame-options'),null);
      assert.match(widget.headers.get('content-security-policy'),/frame-ancestors \\*/);
      for (const response of [widget,photo]) { const csp=response.headers.get('content-security-policy'); assert.ok(csp.includes("connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com;")||csp.endsWith("connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com")); assert.ok(!csp.includes('www.googleapis.com')); assert.ok(!/firestore|cloudfunctions|firebasestorage/.test(csp)) }
      const asset=await fetch('http://gateway:8081/_next/static/test.js',{headers:h});
      assert.match(asset.headers.get('cache-control'),/immutable/);
      const codes=await Promise.all(Array.from({length:2500},()=>fetch('http://gateway:8081/r/demo',{headers:{...h,'CF-Connecting-IP':'203.0.113.44'}}).then(r=>r.status)));
      assert.ok(codes.includes(429),'el límite debe producir 429 para un único cliente');
      const other=await fetch('http://gateway:8081/r/demo',{headers:{...h,'CF-Connecting-IP':'203.0.113.45'}});
      assert.equal(other.status,200,'otro cliente del mismo túnel no debe compartir el límite');
      console.log('trusted headers, widget, cache and per-client rate limit: OK');
    })().catch(e=>{console.error(e.message);process.exit(1)});
  `
  console.log(docker('run', '--rm', '--network', network, '--ip', '172.30.42.2', node, 'node', '-e', clientScript))
  // Un fallo upstream suele añadir la URL íntegra al error_log de Nginx.
  docker('stop', '--time', '1', upstream)
  const failure = await fetch(`http://127.0.0.1:${port}/p/path_secret?t=query_secret`, { signal: AbortSignal.timeout(15_000) })
  assert.ok([502, 504].includes(failure.status))
  await new Promise(resolve => setTimeout(resolve, 100))
  const logResult = spawnSync('docker', ['logs', gateway], { encoding: 'utf8' })
  assert.equal(logResult.status, 0)
  const logs = logResult.stdout + logResult.stderr
  for (const secret of ['path_secret', 'query_secret', 'referer_secret']) assert.ok(!logs.includes(secret), `El log contiene ${secret}`)
  assert.match(logs, /receipt/)
  console.log('loopback spoof denied; private logs redacted: OK')
} finally {
  for (const container of containers.reverse()) { try { docker('rm', '-f', container) } catch { /* Recurso propio ya retirado. */ } }
  if (madeNetwork) { try { docker('network', 'rm', network) } catch { /* Mostrar fallos principales sin ocultarlos. */ } }
}
