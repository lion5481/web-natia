import {createHash} from 'node:crypto';
import {
  STORE,
  checkConversationRateLimit,
  checkIpRateLimit,
  createOrGetConversation,
  getActiveConversation,
  getJson,
  isValidId,
  isValidSecret,
  jsonResponse,
  parseJsonBody,
  setJson,
  validateOrigin
} from './chat-storage.js';
import {
  processPendingTelegramReplies
} from './telegram-reply-storage.js';

const TELEGRAM_CHAT_ID = '8544499790';
const MAX_REQUEST_BYTES = 12000;
const DELIVERY_LEASE_MS = 2 * 60 * 1000;

class TelegramDeliveryError extends Error {
  constructor(message, definitive = false){
    super(message);
    this.definitive = definitive;
  }
}

function isNonEmptyString(value, maxLength){
  return typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= maxLength;
}

function buildTelegramText(payload){
  const lines = [
    payload.type === 'visitor_message'
      ? '💬 Nuevo mensaje de visitante desde LABAD'
      : '🔔 Nueva solicitud de contacto desde LABAD',
    `Conversación: ${payload.conversationId}`
  ];
  if(payload.serviceCategory){
    lines.push(`Servicio: ${payload.serviceCategory}`);
  }

  if(payload.type === 'visitor_message'){
    lines.push('', payload.message.text.trim());
  } else {
    const contact = payload.contact;
    lines.push(
      '',
      `Nombre: ${contact.name?.trim() || 'No indicado'}`,
      `Correo: ${contact.email.trim()}`,
      `Teléfono: ${contact.phone.trim()}`
    );
    if(contact.comment?.trim()){
      lines.push(`Comentario: ${contact.comment.trim()}`);
    }
  }

  lines.push('', `Fecha: ${new Date().toLocaleString('es-ES')}`);
  const text = lines.join('\n');
  if(text.length > 4096){
    throw new Error('El mensaje supera el límite permitido por Telegram.');
  }
  return text;
}

function validatePayload(payload){
  if(payload.type !== 'visitor_message' && payload.type !== 'contact_request'){
    return 'El tipo de evento no es válido.';
  }
  if(!isValidId(payload.eventId)){
    return 'El identificador del evento no es válido.';
  }
  if(!isValidId(payload.conversationId)){
    return 'El identificador de conversación no es válido.';
  }
  if(!isValidSecret(payload.conversationSecret)){
    return 'La credencial de conversación no es válida.';
  }
  if(payload.serviceCategory !== undefined
    && payload.serviceCategory !== null
    && (typeof payload.serviceCategory !== 'string' || payload.serviceCategory.length > 120)){
    return 'La categoría del servicio no es válida.';
  }

  if(payload.type === 'visitor_message'){
    if(!payload.message || typeof payload.message !== 'object'
      || !isNonEmptyString(payload.message.text, 3500)){
      return 'El mensaje del visitante no es válido.';
    }
    return null;
  }

  const contact = payload.contact;
  if(!contact || typeof contact !== 'object' || Array.isArray(contact)){
    return 'Los datos de contacto no son válidos.';
  }
  if(contact.name !== undefined && (typeof contact.name !== 'string' || contact.name.length > 200)){
    return 'El nombre no es válido.';
  }
  if(!isNonEmptyString(contact.email, 254)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim())){
    return 'El correo electrónico no es válido.';
  }
  if(!isNonEmptyString(contact.phone, 60)){
    return 'El teléfono es obligatorio.';
  }
  if(contact.comment !== undefined && (typeof contact.comment !== 'string' || contact.comment.length > 1500)){
    return 'El comentario es demasiado largo.';
  }
  return null;
}

async function mapTelegramMessage(conversationId, telegramMessageId, expiresAt){
  const pointerKey = `telegram-message:${TELEGRAM_CHAT_ID}:${telegramMessageId}`;
  const pointer = {conversationId, expiresAt};
  const pointerWrite = await setJson(pointerKey, pointer, {onlyIfNew:true});
  if(!pointerWrite.modified){
    const latestPointer = await getJson(pointerKey);
    if(latestPointer?.conversationId !== conversationId){
      throw new Error('El mensaje de Telegram ya está asociado a otra conversación.');
    }
  }

  const indexKey = `conversation:${conversationId}:telegram-index:${pointerKey}`;
  await setJson(indexKey, {pointerKey, expiresAt}, {onlyIfNew:true});
  await processPendingTelegramReplies(telegramMessageId);
}

async function sendTelegramMessage(text){
  const token = process.env.TELEGRAM_TOKEN;
  if(!isNonEmptyString(token, 512)){
    throw new TelegramDeliveryError('La integración de Telegram no está configurada.', true);
  }

  const telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID, text})
  });
  let result;
  try {
    result = await telegramResponse.json();
  } catch {
    throw new TelegramDeliveryError('Telegram devolvió una respuesta no válida.');
  }
  if(result?.ok === false){
    throw new TelegramDeliveryError('Telegram rechazó el mensaje.', true);
  }
  if(!telegramResponse.ok || result?.ok !== true || !Number.isSafeInteger(result.result?.message_id)){
    throw new TelegramDeliveryError('Telegram no confirmó la entrega.');
  }
  return result.result.message_id;
}

function sameEvent(record, fingerprint){
  return record && typeof record === 'object'
    && record.fingerprint === fingerprint
    && typeof record.status === 'string'
    && Number.isFinite(record.expiresAt);
}

async function claimEvent(eventKey, fingerprint, expiresAt){
  for(let attempt = 0; attempt < 6; attempt++){
    const current = await STORE.getWithMetadata(eventKey, {consistency:'strong', type:'json'});
    if(current && (!current.data || !sameEvent(current.data, fingerprint))){
      return {error:jsonResponse(409, {ok:false, error:'El identificador del evento ya se utilizó.'})};
    }

    if(!current){
      const now = Date.now();
      const pending = {
        status:'pending',
        fingerprint,
        createdAt:now,
        leaseUntil:now + DELIVERY_LEASE_MS,
        expiresAt
      };
      const created = await setJson(eventKey, pending, {onlyIfNew:true});
      if(created.modified) return {record:pending, etag:created.etag};
      continue;
    }

    const record = current.data;
    if(record.expiresAt <= Date.now()){
      return {error:jsonResponse(410, {ok:false, error:'El evento ha expirado.'})};
    }
    if(record.status === 'sent'){
      return {done:true};
    }
    if(record.status === 'accepted'){
      if(!Number.isSafeInteger(record.telegramMessageId)){
        return {error:jsonResponse(502, {ok:false, error:'La confirmación de Telegram no es válida.'})};
      }
      return {accepted:record, etag:current.etag};
    }
    if(record.status === 'uncertain'){
      return {error:jsonResponse(409, {
        ok:false,
        error:'No se pudo confirmar el resultado del envío anterior. Comprueba Telegram antes de volver a intentarlo.'
      })};
    }
    if(record.status === 'pending'){
      if(Number.isFinite(record.leaseUntil) && record.leaseUntil > Date.now()){
        return {error:jsonResponse(409, {
          ok:false,
          error:'El mensaje todavía se está procesando. Inténtalo de nuevo en unos segundos.'
        })};
      }
      const uncertain = {
        ...record,
        status:'uncertain',
        leaseUntil:null,
        updatedAt:Date.now()
      };
      const result = await setJson(eventKey, uncertain, {onlyIfMatch:current.etag});
      if(result.modified){
        return {error:jsonResponse(409, {
          ok:false,
          error:'No se pudo confirmar el resultado del envío anterior. Comprueba Telegram antes de volver a intentarlo.'
        })};
      }
      continue;
    }
    if(record.status === 'failed'){
      const now = Date.now();
      const pending = {
        ...record,
        status:'pending',
        createdAt:now,
        leaseUntil:now + DELIVERY_LEASE_MS,
        updatedAt:now
      };
      const result = await setJson(eventKey, pending, {onlyIfMatch:current.etag});
      if(result.modified) return {record:pending, etag:result.etag};
      continue;
    }
    return {error:jsonResponse(409, {ok:false, error:'El evento está en un estado no reconocido.'})};
  }
  return {error:jsonResponse(409, {ok:false, error:'El evento está siendo procesado. Inténtalo de nuevo.'})};
}

async function saveAcceptedEvent(eventKey, accepted, claimEtag){
  let expectedEtag = claimEtag;
  for(let attempt = 0; attempt < 4; attempt++){
    const result = await setJson(eventKey, accepted, {onlyIfMatch:expectedEtag});
    if(result.modified) return result.etag;

    const current = await STORE.getWithMetadata(eventKey, {consistency:'strong', type:'json'});
    if(!current || !sameEvent(current.data, accepted.fingerprint)){
      throw new Error('No se pudo guardar la confirmación de Telegram.');
    }
    if(current.data.status === 'accepted' || current.data.status === 'sent'){
      if(current.data.telegramMessageId !== accepted.telegramMessageId){
        throw new Error('El evento tiene un identificador de Telegram inesperado.');
      }
      return current.etag;
    }
    if(current.data.status !== 'pending' && current.data.status !== 'uncertain'){
      throw new Error('El evento cambió de estado durante el envío.');
    }
    expectedEtag = current.etag;
  }
  throw new Error('No se pudo guardar la confirmación de Telegram.');
}

async function markEventUncertain(eventKey, pendingRecord, claimEtag){
  const result = await setJson(eventKey, {
    ...pendingRecord,
    status:'uncertain',
    updatedAt:Date.now(),
  }, {onlyIfMatch:claimEtag.etag});
  return result.modified;
}

async function processEvent(payload){
  const conversationResult = await createOrGetConversation(
    payload.conversationId,
    payload.conversationSecret,
    payload.serviceCategory
  );
  if(conversationResult.error){
    return jsonResponse(conversationResult.statusCode, {ok:false, error:conversationResult.error});
  }
  const conversation = conversationResult.record;
  const activeConversation = await getActiveConversation(payload.conversationId, payload.conversationSecret);
  if(!activeConversation){
    return jsonResponse(410, {ok:false, error:'La conversación ha expirado o se ha cerrado.'});
  }
  if(!await checkConversationRateLimit(payload.conversationId)){
    return jsonResponse(429, {ok:false, error:'Se han enviado demasiadas solicitudes. Inténtalo más tarde.'});
  }

  const text = buildTelegramText(payload);
  const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const eventKey = `conversation:${payload.conversationId}:event:${payload.eventId}`;
  const claim = await claimEvent(eventKey, fingerprint, conversation.expiresAt);
  if(claim.error) return claim.error;
  if(claim.done) return jsonResponse(200, {ok:true});

  if(claim.accepted){
    await mapTelegramMessage(
      payload.conversationId,
      claim.accepted.telegramMessageId,
      conversation.expiresAt
    );
    const current = await STORE.getWithMetadata(eventKey, {consistency:'strong', type:'json'});
    if(current?.data?.status === 'accepted' && current.data.fingerprint === fingerprint){
      await setJson(
        eventKey,
        {...current.data, status:'sent', updatedAt:Date.now()},
        {onlyIfMatch:current.etag}
      );
    }
    return jsonResponse(200, {ok:true});
  }

  let telegramMessageId;
  try {
    telegramMessageId = await sendTelegramMessage(text);
  } catch (error) {
    if(error instanceof TelegramDeliveryError && error.definitive){
      await setJson(eventKey, {
        ...claim.record,
        status:'failed',
        leaseUntil:null,
        updatedAt:Date.now(),
        error:'telegram_rejected'
      }, {onlyIfMatch:claim.etag});
      return jsonResponse(502, {
        ok:false,
        error:'Telegram rechazó el mensaje. Puedes intentarlo de nuevo.'
      });
    }
    await markEventUncertain(eventKey, claim.record, {etag:claim.etag});
    return jsonResponse(502, {
      ok:false,
      error:'No se pudo confirmar el resultado del envío. Comprueba Telegram antes de volver a intentarlo.'
    });
  }

  const eventRecord = {
    ...claim.record,
    status:'accepted',
    telegramMessageId,
    leaseUntil:null,
    acceptedAt:Date.now()
  };
  await saveAcceptedEvent(eventKey, eventRecord, claim.etag);

  const closed = await getJson(`closed:${payload.conversationId}`);
  if(closed && Number.isFinite(closed.expiresAt) && closed.expiresAt > Date.now()){
    return jsonResponse(410, {ok:false, error:'La conversación se ha cerrado.'});
  }

  await mapTelegramMessage(payload.conversationId, telegramMessageId, conversation.expiresAt);
  const current = await STORE.getWithMetadata(eventKey, {consistency:'strong', type:'json'});
  if(current?.data?.status === 'accepted' && current.data.fingerprint === fingerprint){
    await setJson(
      eventKey,
      {...current.data, status:'sent', updatedAt:Date.now()},
      {onlyIfMatch:current.etag}
    );
  }
  return jsonResponse(200, {ok:true});
}

export const handler = async (event) => {
  if(event.httpMethod !== 'POST'){
    return jsonResponse(405, {ok:false, error:'Método no permitido.'}, {Allow:'POST'});
  }
  if(!validateOrigin(event)){
    return jsonResponse(403, {ok:false, error:'Origen no permitido.'});
  }
  const contentType = event.headers?.['content-type'] || event.headers?.['Content-Type'] || '';
  if(!contentType.toLowerCase().includes('application/json')){
    return jsonResponse(415, {ok:false, error:'Se requiere contenido JSON.'});
  }

  let payload;
  try {
    payload = parseJsonBody(event, MAX_REQUEST_BYTES);
  } catch (error) {
    return jsonResponse(400, {ok:false, error:error.message});
  }
  const validationError = validatePayload(payload);
  if(validationError){
    return jsonResponse(400, {ok:false, error:validationError});
  }

  try {
    if(!await checkIpRateLimit(event)){
      return jsonResponse(429, {ok:false, error:'Se han enviado demasiadas solicitudes. Inténtalo más tarde.'});
    }
    return await processEvent(payload);
  } catch {
    return jsonResponse(502, {
      ok:false,
      error:'No se pudo confirmar el resultado del envío. Comprueba Telegram antes de volver a intentarlo.'
    });
  }
};
