import {timingSafeEqual} from 'node:crypto';
import {
  getJson,
  jsonResponse
} from './chat-storage.js';
import {
  storeAndProcessTelegramReply
} from './telegram-reply-storage.js';

const TELEGRAM_CHAT_ID = '8544499790';

function equalSecret(actual, expected){
  if(typeof actual !== 'string' || typeof expected !== 'string'
    || !/^[A-Za-z0-9_-]{1,256}$/.test(actual)
    || !/^[A-Za-z0-9_-]{1,256}$/.test(expected)
    || actual.length !== expected.length){
    return false;
  }
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function readHeader(headers, name){
  const key = Object.keys(headers || {}).find(header=>header.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : '';
}

function parseUpdate(event){
  if(typeof event.body !== 'string' || !event.body
    || Buffer.byteLength(event.body, 'utf8') > 16000){
    throw new Error('Invalid update body.');
  }
  let update;
  try {
    update = JSON.parse(event.body);
  } catch {
    throw new Error('Invalid update JSON.');
  }
  if(!update || typeof update !== 'object' || Array.isArray(update)
    || !Number.isSafeInteger(update.update_id) || update.update_id < 0){
    throw new Error('Invalid update.');
  }
  return update;
}

function getReply(update){
  const message = update.message;
  if(!message || message.chat?.type !== 'private'
    || String(message.chat.id) !== TELEGRAM_CHAT_ID
    || String(message.from?.id) !== TELEGRAM_CHAT_ID
    || message.from?.is_bot === true
    || typeof message.text !== 'string'
    || !message.text.trim()
    || !Number.isSafeInteger(message.reply_to_message?.message_id)
    || message.reply_to_message.message_id < 1
    || String(message.reply_to_message?.chat?.id) !== TELEGRAM_CHAT_ID){
    return null;
  }
  if(message.reply_to_message.from?.is_bot !== true){
    return null;
  }

  return {
    messageId:message.reply_to_message.message_id,
    text:message.text.trim().slice(0, 3500)
  };
}

export const handler = async (event) => {
  if(event.httpMethod !== 'POST'){
    return jsonResponse(405, {ok:false}, {Allow:'POST'});
  }

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const actualSecret = readHeader(event.headers, 'x-telegram-bot-api-secret-token');
  if(!equalSecret(actualSecret, expectedSecret)){
    return jsonResponse(403, {ok:false});
  }

  let update;
  try {
    update = parseUpdate(event);
  } catch {
    return jsonResponse(400, {ok:false});
  }

  try {
    const updateKey = `telegram-update:${update.update_id}`;
    const seen = await getJson(updateKey);
    if(seen?.processed){
      return jsonResponse(200, {ok:true});
    }

    const reply = getReply(update);
    if(reply){
      await storeAndProcessTelegramReply(
        update.update_id,
        reply.messageId,
        reply.text
      );
    }
    return jsonResponse(200, {ok:true});
  } catch {
    return jsonResponse(500, {ok:false});
  }
};
