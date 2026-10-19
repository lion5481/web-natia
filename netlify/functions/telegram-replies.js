const {
  STORE,
  checkConversationRateLimit,
  checkIpRateLimit,
  getActiveConversation,
  getJson,
  isValidId,
  isValidSecret,
  jsonResponse,
  parseJsonBody,
  validateOrigin
} = require('./chat-storage');

const MAX_REPLIES_PER_RESPONSE = 50;

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
  const conversationId = payload.conversationId;
  const conversationSecret = payload.conversationSecret;
  const after = payload.after === undefined ? 0 : Number(payload.after);
  if(!isValidId(conversationId) || !isValidSecret(conversationSecret)
    || !Number.isSafeInteger(after) || after < 0){
    return jsonResponse(400, {ok:false, error:'Los datos de consulta no son válidos.'});
  }

  try {
    if(!await checkIpRateLimit(event)){
      return jsonResponse(429, {ok:false, error:'Se han realizado demasiadas consultas.'});
    }
    const conversation = await getActiveConversation(conversationId, conversationSecret);
    if(!conversation){
      return jsonResponse(410, {ok:false, error:'La conversación ha expirado o se ha cerrado.'});
    }
    if(!await checkConversationRateLimit(conversationId)){
      return jsonResponse(429, {ok:false, error:'Se han realizado demasiadas consultas.'});
    }

    const prefix = `conversation:${conversationId}:reply:`;
    const replies = [];
    for await (const page of STORE.list({prefix, paginate:true})){
      for(const blob of page.blobs){
        const updateId = Number(blob.key.slice(prefix.length));
        if(!Number.isSafeInteger(updateId) || updateId <= after) continue;
        const reply = await getJson(blob.key);
        if(!reply || !Number.isFinite(reply.expiresAt) || reply.expiresAt <= Date.now()) continue;
        replies.push({
          updateId:reply.updateId,
          text:reply.text,
          createdAt:reply.createdAt
        });
      }
    }
    replies.sort((a,b)=>a.updateId - b.updateId);
    return jsonResponse(200, {
      ok:true,
      replies:replies.slice(0, MAX_REPLIES_PER_RESPONSE),
      lastUpdateId:replies.length > MAX_REPLIES_PER_RESPONSE
        ? replies[MAX_REPLIES_PER_RESPONSE - 1].updateId
        : replies.length ? replies[replies.length - 1].updateId : after
    });
  } catch {
    return jsonResponse(502, {ok:false, error:'No se pudieron consultar las respuestas.'});
  }
};
