// Solo emuladores: se autentica con una cuenta existente y usa la callable real.
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FUNCTIONS_EMULATOR_HOST) throw new Error('Indica FIREBASE_AUTH_EMULATOR_HOST y FUNCTIONS_EMULATOR_HOST de tus emuladores.')
const email = process.env.MENSAJES_EMAIL, password = process.env.MENSAJES_PASSWORD
if (!email || !password) throw new Error('Indica MENSAJES_EMAIL y MENSAJES_PASSWORD de una cuenta con permiso para ver mensajes.')
const auth = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})})
const session = await auth.json() as {idToken?:string}
if (!session.idToken) throw new Error('No se ha podido iniciar sesión.')
const response = await fetch(`http://${process.env.FUNCTIONS_EMULATOR_HOST}/demo-llenamos/europe-west1/procesarMensajesPendientes`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.idToken}`},body:JSON.stringify({data:{...(process.argv[2] ? {restaurantId:process.argv[2]} : {})}})})
console.log(await response.json())
if (!response.ok) process.exitCode=1
