const contactForm = document.getElementById('contactForm');

if (contactForm) {
  contactForm.addEventListener('submit', async event => {
    event.preventDefault();

    const form = event.currentTarget;
    const status = form.querySelector('#formMsg');
    const submitButton = form.querySelector('[type="submit"]');
    if (!status || !submitButton) {
      console.error('El formulario de contacto necesita un mensaje de estado y un botón de envío.');
      return;
    }

    const originalButtonText = submitButton.textContent;
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    submitButton.disabled = true;
    submitButton.textContent = 'Enviando...';
    status.classList.remove('error');
    status.setAttribute('role', 'status');
    status.textContent = '';
    status.classList.add('show');

    try {
      const response = await fetch('https://formspree.io/f/xyeebjvv', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`Formspree respondió con HTTP ${response.status}.`);
      }

      status.textContent = '¡Gracias! Nos pondremos en contacto contigo pronto.';
      form.reset();
    } catch (error) {
      console.error('No se pudo enviar el formulario de contacto:', error);
      status.setAttribute('role', 'alert');
      status.classList.add('error');
      status.textContent = 'Ha ocurrido un error. Por favor inténtalo de nuevo.';
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = originalButtonText;
    }
  });
}
