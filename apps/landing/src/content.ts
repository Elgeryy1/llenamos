// Todo el texto de la web de venta en un sitio, para poder cambiarlo sin tocar el diseño.
//
// Regla: aquí no va nada inventado presentado como real. Llenamos aún no tiene clientes,
// así que no hay cifras de uso, opiniones ni logos de restaurantes. Solo se describe lo
// que hace la fase 1 (PLAN.md); lo de fases posteriores sale como «próximamente», sin
// fechas. Las vistas del panel son ilustraciones con datos del restaurante de
// demostración Taberna Lumbre, que es inventado, y lo dicen.

/** Dirección a la que llegan las solicitudes de piloto y las preguntas. */
export const CONTACT_EMAIL = "hola@logiqd.me"

export const CTA = "Empieza gratis 30 días"
export const CTA_SHORT = "Empieza gratis"
export const CTA_NOTE = "Sin tarjeta y sin permanencia. Te lo dejamos montado."

export const NAV = [
  { id: "producto", label: "Producto" },
  { id: "como-funciona", label: "Cómo funciona" },
  { id: "demo", label: "Demo" },
  { id: "precios", label: "Precios" },
  { id: "preguntas", label: "Preguntas" },
]

/** Por dónde entran las reservas (la franja que se desplaza debajo del panel). */
export const CHANNELS = [
  "Tu página de reservas",
  "El widget de tu web",
  "El enlace de tu Instagram",
  "El botón «Reservar» de tu ficha de Google",
  "Las que apuntas por teléfono",
  "Las que importas desde Excel",
]

/** El problema, sin cifras: no tenemos datos propios y no ponemos datos sin fuente. */
export const PAINS = [
  {
    title: "Mesas que se quedan vacías",
    text: "Gente que reservó, no avisó y no vino. La mesa estuvo guardada toda la noche.",
  },
  {
    title: "El teléfono en pleno servicio",
    text: "Llamadas para reservar, cambiar o cancelar justo cuando la sala está llena.",
  },
  {
    title: "Reservas en cuatro sitios",
    text: "La libreta, el WhatsApp del encargado, los mensajes de Instagram y el correo.",
  },
]

export const STEPS = [
  {
    n: "01",
    title: "Dibuja tu sala",
    text: "Coloca las mesas con sus plazas y marca cuáles se pueden juntar. Pon tus turnos y cuánto dura una mesa según el tamaño del grupo.",
  },
  {
    n: "02",
    title: "Abre tus canales",
    text: "Tu página de reservas con tu marca, el widget para tu web y el mismo enlace para Instagram y el botón «Reservar» de tu ficha de Google. Si tienes reservas en un Excel, las importas.",
  },
  {
    n: "03",
    title: "Sirve con el plano delante",
    text: "Llenamos confirma y recuerda por correo y WhatsApp, pide la señal si la activas y avisa a la lista de espera cuando se libera una mesa. Te sugiere dónde sentar a cada grupo y decides tú.",
  },
]

/** Lo que hace hoy Llenamos Reservas (fase 1 de PLAN.md). */
export const INCLUDED = [
  {
    title: "Página de reservas con tu marca",
    text: "Con tu nombre y tu color. El cliente elige personas, día y hora entre las que de verdad quedan libres.",
  },
  {
    title: "Widget para tu web y enlace para Instagram y Google",
    text: "El mismo enlace sirve para tu perfil de Instagram y para el botón «Reservar» de tu ficha de Google.",
  },
  {
    title: "Confirmación y recordatorio",
    text: "Por correo y por WhatsApp, el día antes. El cliente confirma o cancela respondiendo al mensaje.",
  },
  {
    title: "Señal con tarjeta",
    text: "Por persona y desde el tamaño de grupo que elijas, cobrada con Stripe, y tu política de cancelación a la vista.",
  },
  {
    title: "Lista de espera que avisa sola",
    text: "Cuando se libera una mesa, avisa a quien espera y puede quedársela desde el enlace del mensaje.",
  },
  {
    title: "Plano de sala en directo",
    text: "Cada mesa con su estado: libre, reservada o sentada. Lo ve todo el equipo a la vez, en el móvil, la tablet o el ordenador.",
  },
  {
    title: "Mesa sugerida",
    text: "Llenamos propone la mesa donde mejor cabe cada grupo y explica por qué. La decisión es del encargado.",
  },
  {
    title: "Ficha de cliente",
    text: "Visitas, no presentados, notas y alergias, para que quien atiende lo sepa antes de que llegue.",
  },
  {
    title: "Importar desde Excel",
    text: "Trae las reservas que ya tienes. Si una fila tiene un error, te dice cuál y por qué.",
  },
  {
    title: "Petición de reseña en Google",
    text: "Al día siguiente de la visita, un mensaje amable con el enlace a tu ficha.",
  },
  {
    title: "Equipo con roles",
    text: "Propietario, encargado, camarero, cocina y barra. Cada uno ve lo que le toca, y queda registrado quién cambia qué.",
  },
]

/** Fases posteriores de PLAN.md. Sin fechas a propósito. */
export const COMING = [
  { title: "Comandero", text: "Tomar nota en el móvil o la tablet y pedir desde la mesa con un QR." },
  { title: "Cocina y barra", text: "Pantallas por estación, con tiempos y pases." },
  { title: "Caja", text: "Cobros, dividir la cuenta y tickets con Verifactu." },
  { title: "Repite", text: "Tarjeta de sellos en Google Wallet con la marca del restaurante." },
]

/** Lo que gana un restaurante por entrar pronto. Solo lo que es cierto hoy. */
export const PILOT = [
  {
    title: "Lo montamos contigo",
    text: "Nos cuentas cómo es tu sala y tus turnos, y dejamos el plano y los horarios listos a tu lado.",
  },
  {
    title: "Hablas con quien lo hace",
    text: "Sin centralitas: escribes a LogiQD y te contesta el equipo que construye Llenamos.",
  },
  {
    title: "Tu día a día decide lo siguiente",
    text: "Lo que eches en falta en tu servicio pesa en lo que construimos después.",
  },
]

export const PLANS = [
  {
    id: "barra",
    name: "Barra",
    for: "Para bares y locales pequeños",
    monthly: 49,
    yearly: 39,
    features: [
      "Un local",
      "Página de reservas, widget y enlace para Instagram y Google",
      "Plano de sala en directo",
      "Confirmación y recordatorio por correo",
      "Ficha de cliente e importación desde Excel",
      "Equipo con roles",
    ],
    soon: [],
    highlight: false,
  },
  {
    id: "sala",
    name: "Sala",
    for: "Para restaurantes con servicio completo",
    monthly: 99,
    yearly: 79,
    features: [
      "Todo lo del plan Barra",
      "Confirmación y recordatorio por WhatsApp",
      "Señal con tarjeta y política de cancelación",
      "Lista de espera que avisa sola",
      "Mesa sugerida para cada grupo",
      "Petición de reseña en Google",
    ],
    soon: ["Comandero", "Pantallas de cocina y barra"],
    highlight: true,
  },
  {
    id: "grupo",
    name: "Grupo",
    for: "Para grupos con varios locales",
    monthly: 199,
    yearly: 159,
    features: [
      "Todo lo del plan Sala",
      "Varios locales en una sola cuenta",
      "Acceso de cada persona a sus locales",
    ],
    soon: ["Caja con tickets Verifactu", "Repite, la tarjeta de sellos"],
    highlight: false,
  },
]

export const FAQ = [
  {
    q: "¿Cómo es el alta?",
    a: "Nos dejas tus datos y te escribimos. Preparamos contigo el plano, los turnos y los mensajes, y empiezas tus 30 días gratis. Sin tarjeta y sin permanencia.",
  },
  {
    q: "¿De verdad no hace falta tarjeta para probarlo?",
    a: "No. Durante los 30 días de prueba no te pedimos tarjeta. El alta la hacemos contigo: nos escribes, lo preparamos juntos y empiezas. Si no te convence, lo dejas y no pagas nada.",
  },
  {
    q: "¿Cobráis comisión por cada comensal?",
    a: "No. Pagas una cuota fija al mes según tu plan, tengas las reservas que tengas.",
  },
  {
    q: "¿Hay algún coste aparte?",
    a: "Dos, y no son nuestros: Meta cobra cada mensaje de WhatsApp de confirmación o recordatorio a tu cuenta de WhatsApp Business, y Stripe se queda su comisión por cada señal cobrada con tarjeta. El correo va incluido.",
  },
  {
    q: "¿Necesito WhatsApp Business?",
    a: "Para confirmar y recordar por WhatsApp, sí: hace falta una cuenta de WhatsApp Business conectada a la API oficial de Meta, con la empresa verificada. Sin ella, Llenamos confirma y recuerda por correo.",
  },
  {
    q: "¿Cómo funciona la señal contra los no presentados?",
    a: "Tú eliges el importe por persona, desde cuántas personas se pide y hasta cuándo se puede cancelar gratis. El cliente la paga con tarjeta al reservar, mediante Stripe. Las devoluciones no son automáticas: las decides tú.",
  },
  {
    q: "¿Llenamos está integrado con Google?",
    a: "Con el enlace, sí: pones tu página de reservas en el botón «Reservar» de tu ficha de Google y la gente reserva desde ahí. No es una integración oficial con Reserve with Google, que exige que Google nos apruebe como socio.",
  },
  {
    q: "¿Puedo traerme las reservas que ya tengo?",
    a: "Sí, desde un Excel con el nombre, el teléfono, la fecha, la hora y las personas de cada reserva. Si una fila tiene un error, Llenamos te dice cuál y por qué, y crea las demás.",
  },
  {
    q: "¿Mis camareros necesitan formación?",
    a: "El plano se entiende a simple vista y funciona en el navegador de cualquier móvil, tablet u ordenador. Al darte de alta, se lo enseñamos nosotros a tu equipo.",
  },
  {
    q: "¿Funciona si se va internet en el local?",
    a: "Hoy necesita conexión: sin internet, el panel del local no funciona. Las reservas que entran por tu página no dependen de la conexión del local y las verás al volver la red. Que funcione sin internet está en el plan, pero todavía no está hecho.",
  },
  {
    q: "¿Qué pasa con los datos de mis clientes?",
    a: "Son tuyos. Dentro del restaurante, cada persona ve lo que le permite su rol. Si quieres exportar o borrar los datos de un cliente, de momento nos lo pides y lo hacemos nosotros; hacerlo desde el panel está en el plan.",
  },
  {
    q: "¿Y la sala, la cocina y la caja?",
    a: "Están en camino: comandero, pantallas de cocina y barra, caja con tickets Verifactu y la tarjeta de sellos Repite. Llegarán al mismo programa, sin cambiar nada de lo que ya tengas montado. No damos fechas hasta que estén listas.",
  },
  {
    q: "¿Hay permanencia?",
    a: "No. Pagas mes a mes, o al año con un 20 % menos, y lo dejas cuando quieras.",
  },
]
