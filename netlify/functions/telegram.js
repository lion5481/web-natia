const {createHash} = require('crypto');

const TELEGRAM_CHAT_ID = '8544499790';
const MAX_REQUEST_BYTES = 12000;
const handledEvents = new Map();

function response(statusCode, body, headers = {}){
  return {
    statusCode,
    headers:{
      'Content-Type':'application/json; charset=utf-8',
      'Cache-Control':'no-store',
      ...headers
    },
    body:JSON.stringify(body)
  };
}

function isNonEmptyString(value, maxLength){
  return typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= maxLength;
}

function parseRequestBody(event){
  if(typeof event.body !== 'string' || !event.body){
    throw new Error('El cuerpo de la solicitud está vacío.');
  }

  const bodyText = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  if(Buffer.byteLength(bodyText, 'utf8') > MAX_REQUEST_BYTES){
    throw new Error('La solicitud es demasiado grande.');
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new Error('El JSON de la solicitud no es válido.');
  }
  if(!payload || typeof payload !== 'object' || Array.isArray(payload)){
    throw new Error('El contenido debe ser un objeto JSON.');
  }
  return payload;
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

async function sendToTelegram(text){
  const token = process.env.TELEGRAM_TOKEN;
  if(!isNonEmptyString(token, 512)){
    throw new Error('La integración de Telegram no está configurada.');
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
    throw new Error('Telegram devolvió una respuesta no válida.');
  }
  if(!telegramResponse.ok || result.ok !== true){
    throw new Error('Telegram no aceptó el mensaje.');
  }
}

async function sendOnce(eventId, text, fingerprint){
  const existing = handledEvents.get(eventId);
  if(existing){
    if(existing.fingerprint !== fingerprint){
      throw new Error('El identificador del evento ya se utilizó.');
    }
    return existing.promise;
  }

  const entry = {fingerprint, promise:null, sent:false};
  entry.promise = sendToTelegram(text).then(()=>{
    entry.sent = true;
    while(handledEvents.size > 500){
      const oldestSent = [...handledEvents.entries()].find(([, value])=>value.sent);
      if(!oldestSent) break;
      handledEvents.delete(oldestSent[0]);
    }
  }).catch(error=>{
    if(handledEvents.get(eventId) === entry){
      handledEvents.delete(eventId);
    }
    throw error;
  });
  handledEvents.set(eventId, entry);
  return entry.promise;
}

function validatePayload(payload){
  if(!isNonEmptyString(payload.eventId, 128) || !/^[A-Za-z0-9_-]+$/.test(payload.eventId)){
    return 'El identificador del evento no es válido.';
  }
  if(!isNonEmptyString(payload.conversationId, 128)){
    return 'El identificador de conversación no es válido.';
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

  if(payload.type === 'contact_request'){
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
  return 'El tipo de evento no es válido.';
}

exports.handler = async (event) => {
  if(event.httpMethod !== 'POST'){
    return response(405, {ok:false, error:'Método no permitido.'}, {Allow:'POST'});
  }

  const contentType = event.headers?.['content-type'] || event.headers?.['Content-Type'] || '';
  if(!contentType.toLowerCase().includes('application/json')){
    return response(415, {ok:false, error:'Se requiere contenido JSON.'});
  }

  let payload;
  try {
    payload = parseRequestBody(event);
  } catch (error) {
    return response(400, {ok:false, error:error.message});
  }

  const validationError = validatePayload(payload);
  if(validationError){
    return response(400, {ok:false, error:validationError});
  }

  let text;
  try {
    text = buildTelegramText(payload);
  } catch (error) {
    return response(400, {ok:false, error:error.message});
  }

  try {
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await sendOnce(payload.eventId, text, fingerprint);
    return response(200, {ok:true});
  } catch {
    return response(502, {ok:false, error:'No se pudo entregar el mensaje a Telegram. Inténtalo de nuevo.'});
  }
};
