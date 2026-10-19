exports.handler = async (event) => {
  const { answers } = JSON.parse(event.body);
  const token = process.env.TELEGRAM_TOKEN;
  const chat_id = '8544499790';
  
  const text = '🔔 Nuevo contacto desde labadconsultoria.es\n\n' 
    + answers.join('\n') 
    + '\n\n📅 ' + new Date().toLocaleString('es-ES');

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text })
  });

  return { statusCode: 200 };
};
