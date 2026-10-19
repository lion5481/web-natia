import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {getStore} from '@netlify/blobs';

const CHAT_TTL_MS = 24 * 60 * 60 * 1000;
let activeStore;
export let STORE;

function getActiveStore(){
  if(!activeStore) activeStore = getStore('labad-chat-transient');
  return activeStore;
}

STORE = {
  getWithMetadata: (...args)=>getActiveStore().getWithMetadata(...args),
  setJSON: (...args)=>getActiveStore().setJSON(...args),
  delete: (...args)=>getActiveStore().delete(...args),
  async *list(...args){
    yield* getActiveStore().list(...args);
  }
};

export function setStoreForTesting(store){
  activeStore = store;
}

function jsonResponse(statusCode, body, headers = {}){
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

function parseJsonBody(event, maxBytes = 12000){
  if(typeof event.body !== 'string' || !event.body){
    throw new Error('El cuerpo de la solicitud está vacío.');
  }
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  if(Buffer.byteLength(body, 'utf8') > maxBytes){
    throw new Error('La solicitud es demasiado grande.');
  }

  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error('El JSON de la solicitud no es válido.');
  }
  if(!value || typeof value !== 'object' || Array.isArray(value)){
    throw new Error('El contenido debe ser un objeto JSON.');
  }
  return value;
}

async function getJson(key){
  const entry = await STORE.getWithMetadata(
    key,
    {consistency:'strong', type:'json'}
  );
  if(entry === null) return null;
  const value = entry.data;
  if(!value || typeof value !== 'object' || Array.isArray(value)){
    throw new Error('El registro almacenado no tiene un formato JSON válido.');
  }
  return value;
}

async function setJson(key, value, options = {}){
  const expiresAt = value && typeof value === 'object' ? value.expiresAt : null;
  if(Number.isFinite(expiresAt)){
    const bucket = Math.floor(expiresAt / (60 * 60 * 1000));
    const keyHash = createHash('sha256').update(key).digest('hex');
    await STORE.setJSON(
      `expiry:${bucket}:${keyHash}`,
      {key, expiresAt},
      {onlyIfNew:true}
    );
  }
  return STORE.setJSON(key, value, options);
}

function isValidId(value){
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function isValidSecret(value){
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function hashSecret(secret){
  return createHash('sha256').update(secret).digest('hex');
}

function matchesHash(secret, expectedHash){
  if(!isValidSecret(secret) || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)){
    return false;
  }
  return timingSafeEqual(Buffer.from(hashSecret(secret), 'hex'), Buffer.from(expectedHash, 'hex'));
}

function validateOrigin(event){
  const origin = event.headers?.origin || event.headers?.Origin;
  const allowedOrigins = (process.env.CHAT_ALLOWED_ORIGINS
    || [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL].filter(Boolean).join(',')
    || '')
    .split(',')
    .map(value=>value.trim())
    .filter(Boolean)
    .map(value=>new URL(value).origin);
  if(!origin || !allowedOrigins.includes(origin)){
    return false;
  }
  return true;
}

async function incrementRateLimit(key, limit){
  const now = Date.now();
  for(let attempt = 0; attempt < 5; attempt++){
    const current = await STORE.getWithMetadata(key, {consistency:'strong', type:'json'});
    if(current && (!current.data || !Number.isSafeInteger(current.data.count)
      || !Number.isFinite(current.data.expiresAt))){
      throw new Error('El registro de limitación de solicitudes no es válido.');
    }
    if(!current || current.data.expiresAt <= now){
      const result = await setJson(key, {
        count:1,
        expiresAt:now + 60 * 1000
      }, current ? {onlyIfMatch:current.etag} : {onlyIfNew:true});
      if(result.modified) return true;
      continue;
    }
    if(current.data.count >= limit) return false;
    const result = await setJson(key, {
      count:current.data.count + 1,
      expiresAt:current.data.expiresAt
    }, {onlyIfMatch:current.etag});
    if(result.modified) return true;
  }
  throw new Error('No se pudo aplicar el límite de solicitudes.');
}

async function checkIpRateLimit(event){
  const secret = process.env.RATE_LIMIT_HMAC_SECRET;
  const ip = event.headers?.['x-nf-client-connection-ip'] || event.headers?.['X-Nf-Client-Connection-Ip'];
  if(typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32 || !ip){
    throw new Error('La limitación de solicitudes no está configurada.');
  }
  const ipHash = createHmac('sha256', secret).update(ip).digest('hex');
  return incrementRateLimit(`rate:ip:${ipHash}`, 200);
}

async function checkConversationRateLimit(conversationId){
  if(!isValidId(conversationId)){
    throw new Error('El identificador de conversación no es válido.');
  }
  return incrementRateLimit(`rate:conversation:${conversationId}`, 60);
}

async function getActiveConversation(conversationId, secret){
  if(!isValidId(conversationId) || !isValidSecret(secret)) return null;
  const [record, closed] = await Promise.all([
    getJson(`conversation:${conversationId}`),
    getJson(`closed:${conversationId}`)
  ]);
  if(!record || !Number.isFinite(record.expiresAt)
    || (closed && (!Number.isFinite(closed.expiresAt) || closed.expiresAt > Date.now()))
    || record.expiresAt <= Date.now()){
    return null;
  }
  if(!matchesHash(secret, record.secretHash)) return null;
  return record;
}

async function createOrGetConversation(conversationId, secret, serviceCategory){
  if(!isValidId(conversationId) || !isValidSecret(secret)){
    return {error:'La conversación no es válida.', statusCode:400};
  }
  const existing = await getActiveConversation(conversationId, secret);
  if(existing){
    if(typeof serviceCategory === 'string' && serviceCategory.trim()){
      for(let attempt = 0; attempt < 3; attempt++){
        const current = await STORE.getWithMetadata(
          `conversation:${conversationId}`,
          {consistency:'strong', type:'json'}
        );
        if(!current || current.data.expiresAt <= Date.now()
          || !matchesHash(secret, current.data.secretHash)){
          break;
        }
        if(current.data.serviceCategory) return {record:current.data};
        const updated = {...current.data, serviceCategory:serviceCategory.slice(0, 120)};
        const result = await setJson(
          `conversation:${conversationId}`,
          updated,
          {onlyIfMatch:current.etag}
        );
        if(result.modified) return {record:updated};
      }
    }
    return {record:existing};
  }
  const closed = await getJson(`closed:${conversationId}`);
  const current = await getJson(`conversation:${conversationId}`);
  if(closed && (!Number.isFinite(closed.expiresAt) || closed.expiresAt > Date.now())){
    return {error:'La conversación se ha cerrado.', statusCode:410};
  }
  if(current){
    return {error:!Number.isFinite(current.expiresAt) || current.expiresAt <= Date.now()
      ? 'La conversación ha expirado.'
      : 'La conversación no está disponible.', statusCode:410};
  }
  if(closed){
    await STORE.delete(`closed:${conversationId}`);
  }

  const now = Date.now();
  const record = {
    secretHash:hashSecret(secret),
    createdAt:now,
    expiresAt:now + CHAT_TTL_MS,
    serviceCategory:typeof serviceCategory === 'string' ? serviceCategory.slice(0, 120) : null
  };
  const result = await setJson(`conversation:${conversationId}`, record, {onlyIfNew:true});
  if(result.modified) return {record};
  const raced = await getActiveConversation(conversationId, secret);
  return raced
    ? {record:raced}
    : {error:'No se pudo iniciar la conversación.', statusCode:409};
}

async function getConversationById(conversationId){
  if(!isValidId(conversationId)) return null;
  const [record, closed] = await Promise.all([
    getJson(`conversation:${conversationId}`),
    getJson(`closed:${conversationId}`)
  ]);
  if(!record || !Number.isFinite(record.expiresAt)
    || (closed && (!Number.isFinite(closed.expiresAt) || closed.expiresAt > Date.now()))
    || record.expiresAt <= Date.now()){
    return null;
  }
  return record;
}

async function deleteConversationRecords(conversationId){
  const prefix = `conversation:${conversationId}:`;
  for await (const page of STORE.list({prefix, paginate:true})){
    for(const blob of page.blobs){
      const indexKey = blob.key.slice(prefix.length);
      if(indexKey.startsWith('telegram-index:')){
        const pointerKey = indexKey.slice('telegram-index:'.length);
        const pointer = await getJson(pointerKey);
        if(pointer){
          await setJson(pointerKey, {
            ...pointer,
            closed:true,
            closedAt:Date.now(),
            expiresAt:Date.now() + CHAT_TTL_MS
          });
        }
      }
      await STORE.delete(blob.key);
    }
  }
  await STORE.delete(`conversation:${conversationId}`);
}

export {
  CHAT_TTL_MS,
  checkConversationRateLimit,
  checkIpRateLimit,
  createOrGetConversation,
  deleteConversationRecords,
  getActiveConversation,
  getJson,
  getConversationById,
  hashSecret,
  isValidId,
  isValidSecret,
  jsonResponse,
  matchesHash,
  parseJsonBody,
  setJson,
  validateOrigin
};
