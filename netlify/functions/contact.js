const MAX_REQUEST_BYTES = 12000;

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

function sanitizeLogValue(value, payload){
  if(typeof value !== 'string') return undefined;
  const submittedValues = Object.values(payload)
    .filter(value=>typeof value === 'string' && value.length > 0);
  if(submittedValues.some(submitted=>value.toLowerCase().includes(submitted.toLowerCase()))){
    return '[message omitted: may contain submitted data]';
  }
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bre_[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email redacted]')
    .slice(0, 500);
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

function validatePayload(payload){
  if(!isNonEmptyString(payload.name, 200)){
    return 'El nombre es obligatorio y no puede superar 200 caracteres.';
  }
  if(!isNonEmptyString(payload.email, 254)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email.trim())){
    return 'Introduce un correo electrónico válido.';
  }
  if(typeof payload.company !== 'string' || payload.company.length > 200){
    return 'El nombre de la empresa no puede superar 200 caracteres.';
  }
  if(typeof payload.suppliers !== 'string' || payload.suppliers.length > 80){
    return 'El número de proveedores no es válido.';
  }
  if(!isNonEmptyString(payload.challenge, 5000)){
    return 'El mayor reto es obligatorio y no puede superar 5000 caracteres.';
  }
  return null;
}

function buildEmail(payload){
  const name = payload.name.trim();
  return {
    subject:`Nueva consulta desde LABAD: ${name.replace(/[\r\n]+/g, ' ')}`,
    text:[
      'Nueva consulta desde el formulario de LABAD Consultoría',
      '',
      `Nombre: ${name}`,
      `Empresa: ${payload.company.trim() || 'No indicada'}`,
      `Correo: ${payload.email.trim()}`,
      `Número de proveedores: ${payload.suppliers.trim() || 'No indicado'}`,
      '',
      'Mayor reto:',
      payload.challenge.trim()
    ].join('\n')
  };
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

  const apiKey = process.env.RESEND_API_KEY;
  const recipient = process.env.CONTACT_EMAIL;
  const sender = process.env.CONTACT_FROM;
  if(!isNonEmptyString(apiKey, 512)
    || !isNonEmptyString(recipient, 254)
    || !isNonEmptyString(sender, 320)){
    return response(500, {ok:false, error:'El servicio de correo no está configurado correctamente.'});
  }

  const email = buildEmail(payload);
  try {
    const resendResponse = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({
        from:process.env.CONTACT_FROM,
        to:[process.env.CONTACT_EMAIL],
        reply_to:payload.email.trim(),
        subject:email.subject,
        text:email.text
      })
    });

    console.info('Resend API response', {status:resendResponse.status});
    let result;
    try {
      result = await resendResponse.json();
    } catch {
      console.error('Resend returned a non-JSON response', {status:resendResponse.status});
      return response(502, {ok:false, error:'El proveedor de correo devolvió una respuesta no válida.'});
    }
    if(!resendResponse.ok || typeof result.id !== 'string' || !result.id){
      console.error('Resend rejected contact email request', {
        status:resendResponse.status,
        errorCode:sanitizeLogValue(
          typeof result.name === 'string' ? result.name
            : typeof result.code === 'string' ? result.code
              : typeof result.statusCode === 'number' ? String(result.statusCode) : undefined,
          payload
        ),
        errorMessage:sanitizeLogValue(result.message, payload)
      });
      return response(502, {ok:false, error:'No se pudo entregar el mensaje. Inténtalo de nuevo.'});
    }
    return response(200, {ok:true});
  } catch (error) {
    console.error('Could not reach Resend API', {
      errorName:sanitizeLogValue(error?.name, payload),
      errorMessage:sanitizeLogValue(error?.message, payload)
    });
    return response(502, {ok:false, error:'No se pudo conectar con el proveedor de correo. Inténtalo de nuevo.'});
  }
};
