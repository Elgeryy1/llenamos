// Añade mensajes reales mediante las callables locales a los datos de ambos seeds.
const assert = require('node:assert/strict')
const {initializeApp} = require('firebase-admin/app')
const {getFirestore} = require('firebase-admin/firestore')
assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8096')
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:9102')
initializeApp({projectId:'demo-llenamos'})
async function main() {
 const auth = await fetch('http://127.0.0.1:9102/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key',{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'propietario@lumbre.test',password:'Llenamos2026!',returnSecureToken:true})
 }).then(r=>r.json())
 assert(auth.idToken)
 async function call(name,data) {
  const response=await fetch(`http://127.0.0.1:5012/demo-llenamos/europe-west1/${name}`,{
   method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${auth.idToken}`},body:JSON.stringify({data})
  })
  const result=await response.json()
  assert(response.ok,JSON.stringify(result))
  return result
 }
 const rows=await getFirestore().collection('restaurants/demo-lumbre/locations/centro/reservations').get()
 const pending=rows.docs.filter(d=>d.get('status')==='pending').slice(0,2)
 assert(pending.length===2,'Ejecuta primero ambos seeds')
 for(const doc of pending) await call('cambiarEstadoReserva',{restaurantId:'demo-lumbre',locationId:'centro',reservationId:doc.id,status:'confirmed'})
 await call('cambiarEstadoReserva',{restaurantId:'demo-lumbre',locationId:'centro',reservationId:pending[1].id,status:'cancelled',reason:'Comprobación local de Z1'})
 console.log(await call('procesarMensajesPendientes',{restaurantId:'demo-lumbre'}))
 console.log('Mensajes de confirmación y cancelación creados con las funciones locales.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
