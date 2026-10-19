import {after, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = global.fetch;
const originalEnv = {
  URL:process.env.URL,
  RATE_LIMIT_HMAC_SECRET:process.env.RATE_LIMIT_HMAC_SECRET,
  TELEGRAM_TOKEN:process.env.TELEGRAM_TOKEN,
  TELEGRAM_WEBHOOK_SECRET:process.env.TELEGRAM_WEBHOOK_SECRET
};

process.env.URL = 'https://labad.test';
process.env.RATE_LIMIT_HMAC_SECRET = 'test-rate-limit-secret-at-least-32-bytes';
process.env.TELEGRAM_TOKEN = 'test-token';
process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret';

const storage = await import('../netlify/functions/chat-storage.js');
const replyStorage = await import('../netlify/functions/telegram-reply-storage.js');
const webhook = await import('../netlify/functions/telegram-webhook.js');
const sender = await import('../netlify/functions/telegram.js');
const closer = await import('../netlify/functions/telegram-close.js');

let state;

const store = {
  async getWithMetadata(key, options = {}){
    const current = state.records.get(key);
    if(!current) return null;
    let data = structuredClone(current.data);
    if(options.type === 'json' && typeof data === 'string'){
      data = JSON.parse(data);
    }
    return {data, etag:current.etag, metadata:{}};
  },
  async setJSON(key, data, options = {}){
    if(state.beforeWrite){
      await state.beforeWrite(key);
    }
    if(state.failWrite?.(key)){
      state.failWrite = null;
      throw new Error('Simulated temporary Blobs write failure.');
    }
    const current = state.records.get(key);
    if(options.onlyIfNew && current) return {modified:false};
    if(options.onlyIfMatch && current?.etag !== options.onlyIfMatch){
      return {modified:false};
    }
    const etag = `etag-${++state.etag}`;
    state.records.set(key, {data:structuredClone(data), etag});
    return {modified:true, etag};
  },
  async delete(key){
    state.records.delete(key);
  },
  async *list(options = {}){
    const blobs = [...state.records.keys()]
      .filter(key=>key.startsWith(options.prefix || ''))
      .map(key=>({key}));
    yield {blobs};
  }
};

function makeId(value){
  return `${String(value).padStart(8, '0')}-1234-4234-9876-123456789012`;
}

function makeWebhookEvent(updateId, messageId, text = 'Respuesta', originalIsBot = true){
  return {
    httpMethod:'POST',
    headers:{
      'x-telegram-bot-api-secret-token':process.env.TELEGRAM_WEBHOOK_SECRET
    },
    body:JSON.stringify({
      update_id:updateId,
      message:{
        chat:{id:8544499790, type:'private'},
        from:{id:8544499790},
        text,
        reply_to_message:{
          message_id:messageId,
          chat:{id:8544499790, type:'private'},
          from:{is_bot:originalIsBot}
        }
      }
    })
  };
}

async function createConversation(id, secret){
  await storage.createOrGetConversation(id, secret, null);
}

async function addMessagePointer(messageId, conversationId, expiresAt = Date.now() + 60000){
  await storage.setJson(`telegram-message:8544499790:${messageId}`, {
    conversationId,
    expiresAt
  });
}

function storedReplyKey(conversationId, updateId){
  return `conversation:${conversationId}:reply:${String(updateId).padStart(20, '0')}`;
}

beforeEach(()=>{
  state = {
    records:new Map(),
    etag:0,
    beforeWrite:null,
    failWrite:null
  };
  storage.setStoreForTesting(store);
});

after(()=>{
  global.fetch = originalFetch;
  for(const [key, value] of Object.entries(originalEnv)){
    if(value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('recupera una respuesta recibida antes de que exista el mapeo', async ()=>{
  const conversationId = makeId(1);
  const secret = 'a'.repeat(64);
  const updateId = 101;
  const messageId = 501;
  const eventId = makeId(2);
  await createConversation(conversationId, secret);

  state.beforeWrite = async key=>{
    if(key !== `telegram-message:8544499790:${messageId}`) return;
    state.beforeWrite = null;
    const response = await webhook.handler(makeWebhookEvent(updateId, messageId, 'Respuesta rápida'));
    assert.equal(response.statusCode, 200);
  };
  global.fetch = async()=>({
    ok:true,
    json:async()=>({ok:true, result:{message_id:messageId}})
  });

  const response = await sender.handler({
    httpMethod:'POST',
    headers:{
      'content-type':'application/json',
      origin:'https://labad.test',
      'x-nf-client-connection-ip':'192.0.2.10'
    },
    body:JSON.stringify({
      type:'visitor_message',
      eventId,
      conversationId,
      conversationSecret:secret,
      message:{text:'Consulta del visitante'}
    })
  });

  assert.equal(response.statusCode, 200);
  assert.equal((await storage.getJson(`telegram-update:${updateId}`))?.processed, true);
  assert.equal((await storage.getJson(storedReplyKey(conversationId, updateId)))?.text, 'Respuesta rápida');
  assert.equal(state.records.has(`telegram-pending:8544499790:${messageId}:${String(updateId).padStart(20, '0')}`), false);
});

test('guarda una respuesta normal y procesa duplicados concurrentes una sola vez', async ()=>{
  const conversationId = makeId(3);
  const secret = 'b'.repeat(64);
  const updateId = 102;
  await createConversation(conversationId, secret);
  await addMessagePointer(502, conversationId);

  const event = makeWebhookEvent(updateId, 502, 'Respuesta normal');
  const responses = await Promise.all([
    webhook.handler(event),
    webhook.handler(event),
    webhook.handler(event)
  ]);

  assert.deepEqual(responses.map(response=>response.statusCode), [200, 200, 200]);
  assert.equal((await storage.getJson(storedReplyKey(conversationId, updateId)))?.text, 'Respuesta normal');
  assert.equal([...state.records.keys()].filter(key=>key === storedReplyKey(conversationId, updateId)).length, 1);
});

test('conserva respuestas tempranas distintas cuando se encolan concurrentemente', async ()=>{
  const conversationId = makeId(10);
  const secret = '3'.repeat(64);
  const firstUpdateId = 110;
  const secondUpdateId = 111;
  const messageId = 511;
  await createConversation(conversationId, secret);

  const responses = await Promise.all([
    webhook.handler(makeWebhookEvent(firstUpdateId, messageId, 'Primera')),
    webhook.handler(makeWebhookEvent(secondUpdateId, messageId, 'Segunda'))
  ]);
  assert.deepEqual(responses.map(response=>response.statusCode), [200, 200]);

  const pendingIndex = await storage.getJson(`telegram-pending-index:8544499790:${messageId}`);
  assert.deepEqual(new Set(pendingIndex.updateIds), new Set([firstUpdateId, secondUpdateId]));

  await addMessagePointer(messageId, conversationId);
  await replyStorage.processPendingTelegramReplies(messageId);
  assert.equal((await storage.getJson(storedReplyKey(conversationId, firstUpdateId)))?.text, 'Primera');
  assert.equal((await storage.getJson(storedReplyKey(conversationId, secondUpdateId)))?.text, 'Segunda');
});

test('deja pendiente la actualización si falla temporalmente la escritura de la respuesta', async ()=>{
  const conversationId = makeId(4);
  const secret = 'c'.repeat(64);
  const updateId = 103;
  await createConversation(conversationId, secret);
  await addMessagePointer(503, conversationId);
  state.failWrite = key=>key === storedReplyKey(conversationId, updateId);

  const first = await webhook.handler(makeWebhookEvent(updateId, 503, 'Reintentable'));
  assert.equal(first.statusCode, 500);
  assert.equal(await storage.getJson(`telegram-update:${updateId}`), null);

  const retry = await webhook.handler(makeWebhookEvent(updateId, 503, 'Reintentable'));
  assert.equal(retry.statusCode, 200);
  assert.equal((await storage.getJson(storedReplyKey(conversationId, updateId)))?.text, 'Reintentable');
});

test('no entrega respuestas de conversaciones cerradas o caducadas', async ()=>{
  const closedId = makeId(5);
  const closedSecret = 'd'.repeat(64);
  await createConversation(closedId, closedSecret);
  await addMessagePointer(504, closedId);
  await storage.setJson(
    `conversation:${closedId}:telegram-index:telegram-message:8544499790:504`,
    {pointerKey:'telegram-message:8544499790:504', expiresAt:Date.now() + 60000}
  );
  const closed = await closer.handler({
    httpMethod:'POST',
    headers:{
      'content-type':'application/json',
      origin:'https://labad.test',
      'x-nf-client-connection-ip':'192.0.2.11'
    },
    body:JSON.stringify({conversationId:closedId, conversationSecret:closedSecret})
  });
  assert.equal(closed.statusCode, 200);
  assert.equal((await storage.getJson('telegram-message:8544499790:504'))?.closed, true);
  const closedReply = await webhook.handler(makeWebhookEvent(104, 504));
  assert.equal(closedReply.statusCode, 200);
  assert.equal(await storage.getJson(storedReplyKey(closedId, 104)), null);

  const expiredId = makeId(6);
  const expiredSecret = 'e'.repeat(64);
  await createConversation(expiredId, expiredSecret);
  await addMessagePointer(505, expiredId, Date.now() - 1);
  const expiredReply = await webhook.handler(makeWebhookEvent(105, 505));
  assert.equal(expiredReply.statusCode, 200);
  assert.equal(await storage.getJson(storedReplyKey(expiredId, 105)), null);
});

test('correlaciona solo con la conversación del mensaje original y rechaza mensajes sin mapeo válido', async ()=>{
  const firstId = makeId(7);
  const secondId = makeId(8);
  await createConversation(firstId, 'f'.repeat(64));
  await createConversation(secondId, '1'.repeat(64));
  await addMessagePointer(506, firstId);
  await addMessagePointer(507, secondId);

  const otherConversation = await webhook.handler(makeWebhookEvent(106, 507, 'Solo segunda'));
  assert.equal(otherConversation.statusCode, 200);
  assert.equal(await storage.getJson(storedReplyKey(firstId, 106)), null);
  assert.equal((await storage.getJson(storedReplyKey(secondId, 106)))?.text, 'Solo segunda');

  await webhook.handler(makeWebhookEvent(107, 508, 'Aún sin asociación'));
  assert.ok([...state.records.keys()].some(key=>key.startsWith('telegram-pending:8544499790:508:')));
  await webhook.handler(makeWebhookEvent(108, 509, 'Original no es del bot', false));
  assert.equal([...state.records.keys()].some(key=>key.startsWith('telegram-pending:8544499790:509:')), false);
});

test('recupera la respuesta temprana si falla el primer guardado de la asociación', async ()=>{
  const conversationId = makeId(9);
  const secret = '2'.repeat(64);
  const updateId = 109;
  const messageId = 510;
  let telegramCalls = 0;
  state.beforeWrite = async key=>{
    if(key !== `telegram-message:8544499790:${messageId}`) return;
    state.beforeWrite = null;
    const response = await webhook.handler(
      makeWebhookEvent(updateId, messageId, 'Esperando asociación')
    );
    assert.equal(response.statusCode, 200);
  };
  global.fetch = async()=>{
    telegramCalls++;
    return {
      ok:true,
      json:async()=>({ok:true, result:{message_id:messageId}})
    };
  };
  state.failWrite = key=>key === `telegram-message:8544499790:${messageId}`;
  const request = {
    httpMethod:'POST',
    headers:{
      'content-type':'application/json',
      origin:'https://labad.test',
      'x-nf-client-connection-ip':'192.0.2.12'
    },
    body:JSON.stringify({
      type:'visitor_message',
      eventId:makeId(11),
      conversationId,
      conversationSecret:secret,
      message:{text:'Mensaje original'}
    })
  };
  const firstAttempt = await sender.handler(request);
  assert.equal(firstAttempt.statusCode, 502);
  assert.equal((await storage.getJson(`telegram-update:${updateId}`))?.processed, undefined);

  const retry = await sender.handler(request);
  assert.equal(retry.statusCode, 200);
  assert.equal(telegramCalls, 1);
  assert.equal((await storage.getJson(storedReplyKey(conversationId, updateId)))?.text, 'Esperando asociación');
});
