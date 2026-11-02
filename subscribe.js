document.querySelectorAll('#newsletterForm').forEach(form => {
  form.addEventListener('submit', async event => {
    event.preventDefault();

    const emailInput = form.querySelector('input');
    const submitButton = form.querySelector('button');
    if (!emailInput || !submitButton) {
      console.error('El formulario de suscripción necesita un campo de email y un botón de envío.');
      return;
    }

    let status = form.nextElementSibling;
    if (!status || !status.classList.contains('newsletter-status')) {
      status = document.createElement('p');
      status.className = 'newsletter-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      form.insertAdjacentElement('afterend', status);
    }

    const originalButtonText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = 'Enviando...';
    status.textContent = '';

    try {
      const response = await fetch('https://formspree.io/f/myeebkyy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ email: emailInput.value.trim() })
      });

      if (!response.ok) {
        throw new Error(`Formspree respondió con HTTP ${response.status}.`);
      }

      status.textContent = '¡Gracias! Te has suscrito correctamente.';
      emailInput.value = '';
    } catch (error) {
      console.error('No se pudo completar la suscripción:', error);
      status.textContent = 'Ha ocurrido un error. Por favor inténtalo de nuevo.';
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = originalButtonText;
    }
  });
});
