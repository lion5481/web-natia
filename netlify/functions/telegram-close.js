const {
  CHAT_TTL_MS,
  STORE,
  checkConversationRateLimit,
  checkIpRateLimit,
  deleteConversationRecords,
  getJson,
  isValidId,
  isValidSecret,
  jsonResponse,
  matchesHash,
  parseJsonBody,
  setJson,
  validateOrigin
} = require('./chat-storage');

exports.handler = async (event) => {
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
    payload = parseJsonBody(event, 1000);
  } catch (error) {
    return jsonResponse(400, {ok:false, error:error.message});
  }
  if(!isValidId(payload.conversationId) || !isValidSecret(payload.conversationSecret)){
    return jsonResponse(400, {ok:false, error:'La conversación no es válida.'});
  }

  try {
    if(!await checkIpRateLimit(event)){
      return jsonResponse(429, {ok:false, error:'Se han realizado demasiadas solicitudes.'});
    }
    const key = `conversation:${payload.conversationId}`;
    const existing = await getJson(key);
    if(!existing){
      return jsonResponse(200, {ok:true});
    }
    if(!matchesHash(payload.conversationSecret, existing.secretHash)){
      return jsonResponse(403, {ok:false, error:'No se pudo cerrar la conversación.'});
    }
    if(!await checkConversationRateLimit(payload.conversationId)){
      return jsonResponse(429, {ok:false, error:'Se han realizado demasiadas solicitudes.'});
    }
    if(!Number.isFinite(existing.expiresAt) || existing.expiresAt <= Date.now()){
      return jsonResponse(410, {ok:false, error:'La conversación ya ha expirado.'});
    }

    const now = Date.now();
    await setJson(`closed:${payload.conversationId}`, {
      closedAt:now,
      expiresAt:now + CHAT_TTL_MS
    });
    await deleteConversationRecords(payload.conversationId);
    return jsonResponse(200, {ok:true});
  } catch {
    return jsonResponse(502, {ok:false, error:'No se pudo cerrar la conversación.'});
  }
};
