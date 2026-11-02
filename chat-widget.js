(() => {
  if (document.getElementById('chatFab')) return;

  const scriptUrl = document.currentScript?.src || document.baseURI;
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('chat-widget.css', scriptUrl).href;
  document.head.appendChild(stylesheet);

  document.body.insertAdjacentHTML('beforeend', `
    <button class="chat-fab" id="chatFab" aria-label="Abrir chat" aria-controls="chatWindow" aria-expanded="false">
      <svg viewBox="0 0 512 512" aria-hidden="true"><path d="M512 240c0 114.9-114.6 208-256 208-29.5 0-57.8-4-84.1-11.2-15.5 8.7-39.3 20.6-67.9 28.7-6.6 1.9-13.6 3.1-20.5 3.1-12.5 0-24.8-4.1-34.7-12.2-9.9-8.1-16.7-19.8-18.9-32.5-2.2-12.7.7-25.7 8.1-36.2 12.6-17.8 22.1-36.5 28.2-55.6C19.2 308.4 0 276.2 0 240 0 125.1 114.6 32 256 32s256 93.1 256 208zM160 240a32 32 0 1 0-64 0 32 32 0 0 0 64 0zm128 0a32 32 0 1 0-64 0 32 32 0 0 0 64 0zm128 0a32 32 0 1 0-64 0 32 32 0 0 0 64 0z"/></svg>
    </button>
    <div class="chat-window" id="chatWindow" role="dialog" aria-label="Chat de LABAD Consultoría">
      <div class="chat-head">
        <span>¿Hablamos?</span>
        <button id="chatClose" aria-label="Cerrar chat"><svg viewBox="0 0 384 512" aria-hidden="true"><path d="M342.6 150.6a32 32 0 0 0-45.3-45.3L192 210.7 86.6 105.4a32 32 0 0 0-45.3 45.3L146.7 256 41.4 361.4a32 32 0 0 0 45.3 45.3L192 301.3l105.4 105.4a32 32 0 0 0 45.3-45.3L237.3 256z"/></svg></button>
      </div>
      <div class="chat-body" id="chatBody" role="log" aria-live="polite" aria-relevant="additions"></div>
      <div class="chat-input-row" id="chatInputRow">
        <input id="chatInput" type="text" placeholder="Escribe aquí..." aria-label="Escribe tu mensaje" autocomplete="off">
        <button id="chatSend" type="button" aria-label="Enviar mensaje"><svg viewBox="0 0 512 512" aria-hidden="true"><path d="M476 3.2c-5.3-3.1-11.8-3.6-17.5-1.3L18.6 181.4C7.2 186 0 197 0 209.3c0 12.4 7.3 23.5 18.8 27.9l184.6 70.7 70.7 184.6c4.4 11.5 15.5 18.8 27.9 18.8 12.3 0 23.3-7.2 27.9-18.6L510.1 53.5c2.3-5.7 1.8-12.2-1.3-17.5-2.2-3.8-6.1-7.7-9.9-9.9zM238.1 286.1 61.2 218.3 416.5 75.5 238.1 286.1zm57.4 164.7-67.8-176.9L438.5 95.5 295.5 450.8z"/></svg></button>
      </div>
    </div>
  `);

  const chatFab = document.getElementById('chatFab');
  const chatWindow = document.getElementById('chatWindow');
  const chatClose = document.getElementById('chatClose');
  const chatBody = document.getElementById('chatBody');
  const chatInput = document.getElementById('chatInput');
  const chatSend = document.getElementById('chatSend');
  const chatInputRow = document.getElementById('chatInputRow');
  chatInput.maxLength = 3500;

  function createChatId(){
    if(window.crypto && typeof window.crypto.randomUUID === 'function'){
      return window.crypto.randomUUID();
    }
    if(window.crypto && typeof window.crypto.getRandomValues === 'function'){
      const values = new Uint32Array(4);
      window.crypto.getRandomValues(values);
      return Array.from(values, value=>value.toString(16).padStart(8, '0')).join('-');
    }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  const chatConversation = {
    id: createChatId(),
    status: 'new',
    messages: [],
    contactRequest: null,
    serviceCategory: null,
    name: '',
    consultation: '',
    additionalInformation: []
  };
  chatWindow.dataset.conversationId = chatConversation.id;

  function addChatMessage(text, role){
    const message = {
      id: createChatId(),
      conversationId: chatConversation.id,
      role,
      text,
      createdAt: new Date().toISOString()
    };
    chatConversation.messages.push(message);

    const div = document.createElement('div');
    div.className = 'chat-msg ' + (role === 'visitor' ? 'user' : role === 'agent' ? 'agent' : 'bot');
    div.dataset.messageId = message.id;
    div.dataset.sender = role;
    div.textContent = text;
    chatBody.appendChild(div);
    chatBody.scrollTop = chatBody.scrollHeight;
    return message;
  }

  function showChatChoices(choices){
    const options = document.createElement('div');
    options.className = 'chat-options';
    options.id = 'chatOptions';

    choices.forEach(({choice, label})=>{
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-option-button';
      button.dataset.chatChoice = choice;
      button.textContent = label;
      options.appendChild(button);
    });

    chatBody.appendChild(options);
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  function makeContactField({id, label, type, help, required, multiline}){
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-contact-field';

    const fieldLabel = document.createElement('label');
    fieldLabel.htmlFor = id;
    fieldLabel.textContent = label + (required ? ' *' : '');

    const field = document.createElement(multiline ? 'textarea' : 'input');
    field.id = id;
    if(!multiline) field.type = type;
    field.required = required;
    field.maxLength = id === 'contactName' ? 200
      : id === 'contactEmail' ? 254
      : id === 'contactPhone' ? 60
      : 1500;
    field.autocomplete = id === 'contactName' ? 'name' : id === 'contactEmail' ? 'email' : id === 'contactPhone' ? 'tel' : 'off';
    field.setAttribute('aria-describedby', id + 'Help ' + id + 'Error');

    const helpText = document.createElement('span');
    helpText.className = 'chat-contact-help';
    helpText.id = id + 'Help';
    helpText.textContent = help;

    const error = document.createElement('span');
    error.className = 'chat-contact-error';
    error.id = id + 'Error';
    error.setAttribute('aria-live', 'polite');

    wrapper.append(fieldLabel, field, helpText, error);
    return {wrapper, field, error};
  }

  function showContactForm(){
    addChatMessage(
      'Gracias por compartir esta información. Para que podamos estudiar tu consulta y ponernos en contacto contigo, necesitamos los siguientes datos:',
      'system'
    );
    chatInputRow.hidden = true;

    const form = document.createElement('form');
    form.className = 'chat-contact-form';
    form.noValidate = true;

    const fields = {
      email: makeContactField({
        id:'contactEmail', label:'Correo electrónico', type:'email',
        help:'Obligatorio. Usaremos este correo para responderte.', required:true
      }),
      phone: makeContactField({
        id:'contactPhone', label:'Número de teléfono', type:'tel',
        help:'Obligatorio. No incluyas solo espacios.', required:true
      })
    };

    Object.values(fields).forEach(({wrapper})=>form.appendChild(wrapper));

    const status = document.createElement('p');
    status.className = 'chat-contact-status';
    status.setAttribute('role', 'status');
    status.textContent = 'Correo electrónico y teléfono de contacto.';

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'chat-contact-submit';
    submit.textContent = 'Continuar';
    form.append(status, submit);
    chatBody.appendChild(form);
    chatBody.scrollTop = chatBody.scrollHeight;
    fields.email.field.focus();

    form.addEventListener('submit', event=>{
      event.preventDefault();
      if(chatConversation.contactRequest) return;

      Object.values(fields).forEach(({field, error})=>{
        error.textContent = '';
        field.removeAttribute('aria-invalid');
      });

      const email = fields.email.field.value.trim();
      const phone = fields.phone.field.value.trim();
      let firstInvalidField = null;

      if(!email){
        fields.email.error.textContent = 'Introduce tu correo electrónico.';
        firstInvalidField = fields.email.field;
      } else if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
        fields.email.error.textContent = 'Escribe un correo electrónico válido.';
        firstInvalidField = fields.email.field;
      }

      if(!phone){
        fields.phone.error.textContent = 'Introduce tu número de teléfono.';
        if(!firstInvalidField) firstInvalidField = fields.phone.field;
      }

      [fields.email, fields.phone].forEach(({field, error})=>{
        if(error.textContent) field.setAttribute('aria-invalid', 'true');
      });

      if(firstInvalidField){
        firstInvalidField.focus();
        return;
      }

      chatConversation.contactRequest = {
        conversationId: chatConversation.id,
        name: chatConversation.name,
        email,
        phone,
        createdAt: new Date().toISOString()
      };
      chatConversation.status = 'additional-choice';
      form.remove();
      addChatMessage('Gracias por la información. ¿Quieres añadir algún detalle más sobre tu consulta?', 'system');
      showChatChoices([
        {choice:'add-information', label:'Sí, añadir información'},
        {choice:'finish', label:'No, finalizar'}
      ]);
    });
  }

  function getContactComment(){
    const sections = ['Consulta: ' + chatConversation.consultation];
    if(chatConversation.additionalInformation.length){
      sections.push('Información adicional:\n' + chatConversation.additionalInformation.join('\n'));
    }
    return sections.join('\n\n');
  }

  function getAdditionalInformationRemaining(){
    const separatorLength = chatConversation.additionalInformation.length ? 1 : '\n\nInformación adicional:\n'.length;
    return 1500 - getContactComment().length - separatorLength;
  }

  function showAdditionalInformationPrompt(){
    chatConversation.status = 'additional-choice';
    chatInputRow.hidden = true;
    const hasRoom = getAdditionalInformationRemaining() > 0;
    showChatChoices([
      ...(hasRoom ? [{choice:'add-information', label:'Sí, añadir información'}] : []),
      {choice:'finish', label:'No, finalizar'}
    ]);
  }

  async function sendContactRequest(){
    if(!['additional-choice', 'additional-information'].includes(chatConversation.status)) return;

    const contactRequest = chatConversation.contactRequest;
    if(!contactRequest) return;

    chatConversation.status = 'sending';
    document.getElementById('chatOptions')?.remove();
    chatInputRow.hidden = true;

    try {
      const response = await fetch('https://formspree.io/f/mkjjpzjw', {
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          Accept:'application/json'
        },
        body:JSON.stringify({
          name:chatConversation.name,
          service:chatConversation.serviceCategory,
          message:getContactComment(),
          email:contactRequest.email,
          phone:contactRequest.phone
        })
      });

      if(!response.ok){
        throw new Error(`Formspree respondió con HTTP ${response.status}.`);
      }

      chatConversation.status = 'complete';
      addChatMessage('✅ ¡Gracias! Tu mensaje se ha enviado correctamente. Nuestra agente te contactará lo antes posible.', 'system');
    } catch(error) {
      console.error('No se pudo enviar la consulta del chat:', error);
      chatConversation.status = 'send-failed';
      addChatMessage('Ha ocurrido un error. Por favor escribe a info@labadconsultoria.es', 'system');
    }
  }

  function handleChatChoice(choice){
    if(chatConversation.status !== 'service-choosing' && chatConversation.status !== 'additional-choice') return;
    document.getElementById('chatOptions')?.remove();

    if(chatConversation.status === 'service-choosing'){
      const services = {
        decarbonizacion: 'Descarbonización',
        licitaciones: 'Preparación para licitaciones',
        'compras-sostenibles': 'Compras sostenibles y cadena de suministro',
        'economia-circular': 'Economía circular',
        'otra-consulta': 'Otra consulta'
      };
      const serviceCategory = services[choice];
      if(!serviceCategory) return;

      chatConversation.serviceCategory = serviceCategory;
      addChatMessage(serviceCategory, 'visitor');
      chatConversation.status = 'consultation';
      addChatMessage(
        `Perfecto, ${chatConversation.name}. Has seleccionado ${serviceCategory}. Cuéntame qué necesitas o qué reto te gustaría resolver en esta área.`,
        'system'
      );
      chatInputRow.hidden = false;
      chatInput.maxLength = 1000;
      chatInput.focus();
    } else if(choice === 'add-information' && chatConversation.status === 'additional-choice'){
      const remaining = getAdditionalInformationRemaining();
      if(remaining <= 0){
        showAdditionalInformationPrompt();
        return;
      }
      chatConversation.status = 'additional-information';
      addChatMessage('Por supuesto. Escribe aquí cualquier información adicional que consideres relevante.', 'system');
      chatInputRow.hidden = false;
      chatInput.maxLength = Math.min(remaining, 1500);
      chatInput.focus();
    } else if(choice === 'finish' && chatConversation.status === 'additional-choice'){
      sendContactRequest();
    } else {
      return;
    }
  }

  function startChat(){
    if(chatConversation.status !== 'new') return;
    chatConversation.status = 'greeting';
    chatInput.maxLength = 200;
    addChatMessage('Hola, bienvenido/a a LABAD Consultoría. Soy el asistente virtual y estoy aquí para ayudarte. ¿Cómo te llamas?', 'system');
  }

  function handleChatSend(){
    if(!['greeting', 'consultation', 'additional-information'].includes(chatConversation.status)) return;
    const text = chatInput.value.trim();
    if(!text) return;

    const currentStatus = chatConversation.status;
    addChatMessage(text, 'visitor');
    chatInput.value = '';

    if(currentStatus === 'greeting'){
      chatConversation.name = text.slice(0, 200);
      chatConversation.status = 'service-choosing';
      addChatMessage(
        `Muchas gracias, ${chatConversation.name}. ¿Sobre qué área necesitas asesoramiento?`,
        'system'
      );
      showChatChoices([
        {choice:'decarbonizacion', label:'Descarbonización'},
        {choice:'licitaciones', label:'Preparación para licitaciones'},
        {choice:'compras-sostenibles', label:'Compras sostenibles y cadena de suministro'},
        {choice:'economia-circular', label:'Economía circular'},
        {choice:'otra-consulta', label:'Otra consulta'}
      ]);
    } else if(currentStatus === 'consultation'){
      chatConversation.consultation = text.slice(0, 1000);
      chatConversation.status = 'contact';
      showContactForm();
    } else if(currentStatus === 'additional-information'){
      chatConversation.additionalInformation.push(text);
      sendContactRequest();
    }
  }

  window.LabadChat = Object.freeze({
    conversationId: chatConversation.id,
    getMessages: ()=>chatConversation.messages.map(message=>({...message})),
    getConversation: ()=>({
      id: chatConversation.id,
      status: chatConversation.status,
      serviceCategory: chatConversation.serviceCategory,
      name: chatConversation.name,
      consultation: chatConversation.consultation,
      additionalInformation: [...chatConversation.additionalInformation],
      messages: chatConversation.messages.map(message=>({...message}))
    }),
    getContactRequest: ()=>chatConversation.contactRequest ? {...chatConversation.contactRequest} : null,
    receiveAgentMessage(text){
      if(typeof text !== 'string' || !text.trim()){
        throw new TypeError('El mensaje del agente debe contener texto.');
      }
      return addChatMessage(text.trim(), 'agent');
    }
  });

  chatBody.addEventListener('click', event=>{
    const button = event.target.closest('[data-chat-choice]');
    if(button) handleChatChoice(button.dataset.chatChoice);
  });
  chatFab.addEventListener('click', ()=>{
    const open = chatWindow.classList.toggle('open');
    chatFab.setAttribute('aria-expanded', String(open));
    if(chatWindow.classList.contains('open')) startChat();
  });
  chatClose.addEventListener('click', ()=>{
    chatWindow.classList.remove('open');
    chatFab.setAttribute('aria-expanded', 'false');
    chatFab.focus();
  });
  chatSend.addEventListener('click', handleChatSend);
  chatInput.addEventListener('keydown', event=>{
    if(event.key === 'Enter') handleChatSend();
  });
})();
