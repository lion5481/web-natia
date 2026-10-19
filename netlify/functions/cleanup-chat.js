const {createHash} = require('crypto');
const {STORE, getJson} = require('./chat-storage');

async function refreshExpiryIndex(indexKey, recordKey, expiresAt){
  const bucket = Math.floor(expiresAt / (60 * 60 * 1000));
  const keyHash = createHash('sha256').update(recordKey).digest('hex');
  const refreshedKey = `expiry:${bucket}:${keyHash}`;
  for(let attempt = 0; attempt < 5; attempt++){
    const current = await STORE.getWithMetadata(
      refreshedKey,
      {consistency:'strong', type:'json'}
    );
    if(current && (!current.data || current.data.key !== recordKey)){
      throw new Error('La clave del índice de expiración no coincide.');
    }
    if(current?.data?.expiresAt === expiresAt) break;
    const result = await STORE.setJSON(
      refreshedKey,
      {key:recordKey, expiresAt},
      current ? {onlyIfMatch:current.etag} : {onlyIfNew:true}
    );
    if(result.modified) break;
    if(attempt === 4){
      throw new Error('No se pudo actualizar el índice de expiración.');
    }
  }
  if(refreshedKey !== indexKey) await STORE.delete(indexKey);
}

exports.handler = async () => {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const currentBucket = Math.floor(now / hour);
  let deleted = 0;
  let examined = 0;

  for(let bucket = currentBucket - 25; bucket <= currentBucket; bucket++){
    const prefix = `expiry:${bucket}:`;
    for await (const page of STORE.list({prefix, paginate:true})){
      for(const blob of page.blobs){
        const index = await getJson(blob.key);
        if(typeof index.key !== 'string' || !Number.isFinite(index.expiresAt)){
          await STORE.delete(blob.key);
          continue;
        }
        if(index.expiresAt > now) continue;

        const record = await getJson(index.key);
        if(!record){
          await STORE.delete(blob.key);
          continue;
        }
        if(!Number.isFinite(record.expiresAt) || record.expiresAt <= now){
          await STORE.delete(index.key);
          await STORE.delete(blob.key);
          deleted++;
        } else if(record.expiresAt !== index.expiresAt){
          await refreshExpiryIndex(blob.key, index.key, record.expiresAt);
        }
        examined++;
      }
    }
  }

  return {
    statusCode:200,
    body:JSON.stringify({ok:true, deleted, examined})
  };
};
