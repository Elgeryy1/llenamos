// Punto de entrada de las Cloud Functions. Cada función vive en su propio archivo.
export { crearRestaurante } from './crearRestaurante'
export { altaRestauranteLogiqd, listarRestaurantesAdministracion, configurarRestauranteLogiqd } from './fase6-billing'
export { suscripcionesProgramadas, integracionesProgramadas } from './platform-schedulers'
export { invitarMiembro, aceptarInvitacion } from './invitarMiembro'
export { cambiarRolMiembro } from './cambiarRolMiembro'
export { desactivarMiembro } from './desactivarMiembro'
export { activityRestaurant } from './activityRestaurant'
export { activityMember } from './activityMember'
export { activityArea } from './activityArea'
export { activityTable } from './activityTable'

export { mensajeCreado, mensajesProgramados, procesarMensajesPendientes } from './messages/process'
export { mensajesReservaActualizada } from './messages/lifecycle'
export { apuntarseListaEspera, aceptarOfertaListaEspera } from './waitlist/service'
export { iniciarPagoSenal, stripeWebhook } from './deposit/stripe'
export { whatsappWebhook } from './webhooks/whatsapp'
export { consultarDisponibilidad, crearReservaPublica, verReservaPublica, gestionarReservaPublica, crearReserva, cambiarEstadoReserva, asignarMesas, moverReserva, proponerMesasReserva, guardarConfiguracionReservas, importarReservas, cambiarPlan } from './reservations'
export { reservationChanged, publicRestaurantChanged, publicLocationChanged, publicSettingsChanged } from './reservationTriggers'

export { guardarCategoriaCarta, guardarPlato, guardarMenuDia, ordenarCarta, marcarAgotado, guardarEstacion, guardarConfiguracionSala, recuperarQrMesa, revocarQrMesa, importarQrMesa, regenerarQrMesa, abrirMesa, cambiarEstadoMesa, editarMesa, moverMesa, juntarMesas, separarMesas, enviarPedido, decidirPedido, marcharPase, cambiarEstadoLineas, crearTarea, cambiarEstadoTarea, verMesaPublica, pedirDesdeMesa, avisarDesdeMesa, consultarRecogida, pedirParaLlevar, verParaLlevarPublico, crearParaLlevar, cambiarEstadoParaLlevar } from './fase2'
export { marcharParaLlevar } from './fase2/process'
export { cartaPublica, cartaLocal, cartaRestaurante, actividadSala, reconciliarSala } from './fase2/triggers'

export { guardarRaciones } from './fase2'

export { configuracionPush, guardarSuscripcionPush } from './fase2'
export { avisosRetrasados } from './fase2/push-process'
export { sincronizarComando, recuperarComando, descartarComando, prepararSinConexion } from './fase6-sync'

// Las tres piezas comparten el único libro de caja y sus transacciones.
import { connectCajaServices } from './fase3-mobile/backend'
import { confirmExternalPayment, issuePartInvoice } from './fase3/service'
connectCajaServices({ confirmExternalPayment, issuePartInvoice })
export {
  guardarConfiguracionCaja, abrirCaja, cerrarCaja, registrarMovimientoCaja,
  abrirCuenta, verCuenta, ajustarCuenta, dividirCuenta, prepararCobro,
  desbloquearCuenta, registrarCobro, devolverCobro, emitirFactura,
  rectificarFactura, sustituirSimplificada, anularRegistroFiscal, repartirPropinas,
} from './fase3'
export {
  guardarImpresora, vincularPuente, solicitarImpresion, reclamarImpresiones,
  confirmarImpresion, peticionImpresion, comandaMarchada, impresoraActualizada,
} from './fase3-print'
export {
  crearEnlaceCobro, verCobroPublico, iniciarPagoCuenta, crearReciboDigital,
  verReciboDigital, verPartesPagoMesa, elegirPartePagoMesa,
  stripeCuentaWebhook, reconciliarPagosMoviles,
} from './fase3-mobile'

// Fase 4: personal (fichaje, horas y cuadrante), inventario, escandallos y compras.
export {
  guardarConfiguracionPersonal, fichar, ficharEnPuesto, guardarPinFichaje, crearFichajeManual, corregirFichaje,
  cerrarFichajeOlvidado, anularFichaje, informeHoras, exportarMisFichajes, guardarTurno, borrarTurno, publicarCuadrante,
  copiarSemanaCuadrante, horasParaPropinas, guardarConfiguracionInventario, guardarIngrediente, guardarReceta,
  registrarMerma, ajustarStock, iniciarRecuento, guardarRecuento, aplicarRecuento, cancelarRecuento,
  reconocerAvisoStock, guardarProveedor, guardarFormatoProveedor, guardarPedidoProveedor,
  cambiarEstadoPedidoProveedor, recibirPedidoProveedor, sugerirPedidos, margenPlatos,
  consumirPorLinea, reconciliarConsumos, revisarFichajesAbiertos,
} from './fase4'

// Fase 6 · plataforma: alta y facturación de la suscripción, panel LogiQD, API pública y webhooks.
export {
  listarPlanesDisponibles, guardarAlta, completarAlta, verSuscripcion, iniciarSuscripcion,
  abrirPortalFacturacion, cancelarSuscripcion, guardarPlanPlataforma, cambiarExcepcionesPlataforma, stripeBillingWebhook,
} from './fase6-billing'
export {
  listarRestaurantesLogiqd, verUsoPlataforma, abrirAccesoSoporte, listarIntegraciones, crearClaveApi,
  revocarClaveApi, guardarWebhook, rotarSecretoWebhook, repetirEntregaWebhook, plataformaApi,
} from './fase6-api'

// Fase 6: privacidad (consentimientos, exportar, borrar o anonimizar) y copias con simulacro de restauración.
export {
  registrarConsentimiento, solicitarPrivacidad, verificarSolicitudPrivacidad, descargarExportacionPrivacidad,
  listarSolicitudesPrivacidad, privacyDownload,
} from './fase6-privacy'
export { privacidadProgramada } from './fase6-privacy/process'
export { crearCopiaSeguridad, simularRestauracion, verContinuidad } from './fase6-backup'
export { copiasProgramadas } from './fase6-backup/process'
export {
  guardarConfiguracionFidelizacion, guardarPremio, altaFidelizacion, verCuentaFidelizacion,
  canjearPuntos, anularCanje, ajustarPuntos, guardarPromocion, cambiarEstadoPromocion,
  promocionesAplicables, aplicarPromocion, quitarPromocion, vincularRepite, guardarAjustesRepite,
  crearTarjetaRepite, verTarjetaRepite, darSelloRepite, avisarTeEchamosDeMenos, informeRepite,
  guardarConfiguracionMarketing, guardarSegmento, borrarSegmento, previsualizarSegmento,
  guardarCampana, simularCampana, lanzarCampana, cancelarCampana, informeCampana,
  darseDeBaja, informeOrigen, panelAnalisis, exportarAnalisis, guardarConfiguracionAnalisis,
  previsionOcupacion, verResumenDiario, guardarAutomatizacion, borrarAutomatizacion,
  simularAutomatizacion, resolverRecomendacion,
  acumularPuntos, revertirPuntosPorDevolucion, caducarPuntos,
  selloRepitePorReserva, selloRepitePorCobro, repiteOperacionCreada, procesarRepite,
  procesarCampanas, cancelarMarketingSinPermiso, agregarDiaAnalisis, enviarResumenDiario,
  eventoAnalisisReserva, eventoAnalisisStock, evaluarAutomatizaciones, caducarRecomendaciones,
  repiteLocal,
} from './fase5'
