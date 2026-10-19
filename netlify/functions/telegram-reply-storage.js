const {
  CHAT_TTL_MS,
  STORE,
  getJson,
  getConversationById,
  setJson
} = require('./chat-storage');

const TELEGRAM_CHAT_ID = '8544499790';

function updateKey(updateId){
  return `telegram-update:${updateId}`;
}

function pendingPrefix(messageId){
  return `telegram-pending:${TELEGRAM_CHAT_ID}:${messageId}:`;
}

function pendingKey(messageId, updateId){
  return `${pendingPrefix(messageId)}${String(updateId).padStart(20, '0')}`;
}

function pendingIndexKey(messageId){
  return `telegram-pending-index:${TELEGRAM_CHAT_ID}:${messageId}`;
}

async function changePendingIndex(messageId, updateId, expiresAt, add){
  const key = pendingIndexKey(messageId);
  for(let attempt = 0; attempt < 8; attempt++){
    const current = await STORE.getWithMetadata(
      key,
      {consistency:'strong', type:'json'}
    );
    if(current && (!current.data || !Array.isArray(current.data.updateIds)
      || !Number.isFinite(current.data.expiresAt))){
      throw new Error('El índice de respuestas pendientes no es válido.');
    }

    const updateIds = current ? current.data.updateIds : [];
    const hasUpdate = updateIds.includes(updateId);
    if(add ? hasUpdate : !hasUpdate) return;
    if(add && updateIds.length >= 100){
      throw new Error('Hay demasiadas respuestas pendientes para este mensaje.');
    }

    const next = {
      updateIds:add ? [...updateIds, updateId] : updateIds.filter(id=>id !== updateId),
      expiresAt:add
        ? Math.max(current?.data?.expiresAt || 0, expiresAt)
        : current.data.expiresAt
    };
    const result = await setJson(
      key,
      next,
      current ? {onlyIfMatch:current.etag} : {onlyIfNew:true}
    );
    if(result.modified) return;
  }
  throw new Error('No se pudo actualizar el índice de respuestas pendientes.');
}

async function markUpdateProcessed(updateId, expiresAt){
  const key = updateKey(updateId);
  const current = await getJson(key);
  if(current?.processed) return;

  const result = await setJson(key, {
    expiresAt,
    processed:true
  }, {onlyIfNew:true});
  if(result.modified) return;

  const raced = await getJson(key);
  if(!raced?.processed){
    throw new Error('No se pudo confirmar la actualización de Telegram.');
  }
}

async function deletePending(key){
  if(key) await STORE.delete(key);
}

async function removePending(messageId, updateId, key){
  await deletePending(key);
  await changePendingIndex(messageId, updateId, Date.now() + CHAT_TTL_MS, false);
}

async function processPendingReply(key, pending, pointer){
  const now = Date.now();
  if(!pointer || pointer.closed === true
    || !Number.isFinite(pointer.expiresAt) || pointer.expiresAt <= now
    || typeof pointer.conversationId !== 'string'){
    await markUpdateProcessed(pending.updateId, now + CHAT_TTL_MS);
    await removePending(pending.messageId, pending.updateId, key);
    return;
  }

  const conversation = await getConversationById(pointer.conversationId);
  if(!conversation){
    await markUpdateProcessed(pending.updateId, now + CHAT_TTL_MS);
    await removePending(pending.messageId, pending.updateId, key);
    return;
  }

  const expiresAt = Math.min(conversation.expiresAt, now + CHAT_TTL_MS);
  const replyKey = `conversation:${pointer.conversationId}:reply:${String(pending.updateId).padStart(20, '0')}`;
  const reply = {
    updateId:pending.updateId,
    text:pending.text,
    createdAt:pending.createdAt,
    expiresAt
  };
  const saved = await setJson(replyKey, reply, {onlyIfNew:true});
  if(!saved.modified){
    const existing = await getJson(replyKey);
    if(!existing || existing.updateId !== pending.updateId
      || existing.text !== pending.text){
      throw new Error('La respuesta de Telegram ya está asociada a otro contenido.');
    }
  }

  const stillActive = await getConversationById(pointer.conversationId);
  if(!stillActive){
    await STORE.delete(replyKey);
    await markUpdateProcessed(pending.updateId, now + CHAT_TTL_MS);
    await removePending(pending.messageId, pending.updateId, key);
    return;
  }

  await markUpdateProcessed(pending.updateId, expiresAt);
  await removePending(pending.messageId, pending.updateId, key);
}

async function storeAndProcessTelegramReply(updateId, messageId, text){
  const now = Date.now();
  const key = pendingKey(messageId, updateId);
  const pending = {
    updateId,
    messageId,
    text,
    createdAt:now,
    expiresAt:now + CHAT_TTL_MS
  };
  let pointer = await getJson(`telegram-message:${TELEGRAM_CHAT_ID}:${messageId}`);
  const saved = await setJson(key, pending, {onlyIfNew:true});
  let stored = pending;
  if(!saved.modified){
    stored = await getJson(key);
    if(!stored || stored.updateId !== updateId
      || stored.messageId !== messageId || stored.text !== text){
      throw new Error('La actualización de Telegram no coincide con su registro pendiente.');
    }
  }

  if(!pointer){
    await changePendingIndex(messageId, updateId, stored.expiresAt, true);
    pointer = await getJson(`telegram-message:${TELEGRAM_CHAT_ID}:${messageId}`);
  }
  if(!pointer) return false;

  await processPendingReply(key, stored, pointer);
  return true;
}

async function processPendingTelegramReplies(messageId){
  const pointer = await getJson(`telegram-message:${TELEGRAM_CHAT_ID}:${messageId}`);
  if(!pointer) throw new Error('No se encontró la asociación del mensaje de Telegram.');

  const index = await getJson(pendingIndexKey(messageId));
  if(!index) return;
  if(!Array.isArray(index.updateIds) || !Number.isFinite(index.expiresAt)){
    throw new Error('El índice de respuestas pendientes no es válido.');
  }

  for(const updateId of index.updateIds){
    if(!Number.isSafeInteger(updateId) || updateId < 0){
      throw new Error('El índice contiene un identificador de actualización no válido.');
    }
    const key = pendingKey(messageId, updateId);
    const pending = await getJson(key);
    if(!pending){
      await changePendingIndex(messageId, updateId, index.expiresAt, false);
      continue;
    }
    if(pending.updateId !== updateId || pending.messageId !== messageId
      || typeof pending.text !== 'string'
      || !Number.isFinite(pending.expiresAt)){
      throw new Error('La respuesta pendiente no es válida.');
    }
    if(pending.expiresAt <= Date.now()){
      await markUpdateProcessed(updateId, Date.now() + CHAT_TTL_MS);
      await removePending(messageId, updateId, key);
      continue;
    }
    await processPendingReply(key, pending, pointer);
  }
}

module.exports = {
  processPendingTelegramReplies,
  storeAndProcessTelegramReply
};
