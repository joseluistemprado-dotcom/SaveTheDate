const form = document.querySelector('#rsvp-form');
const attendees = document.querySelector('#attendees-field');
const error = document.querySelector('.form-error');

if (form) {
  document
    .querySelectorAll('input[name="attending"]')
    .forEach(input => {
      input.addEventListener('change', () => {
        attendees.hidden =
          input.value !== 'yes' ||
          !input.checked;

        attendees.querySelector('input').required =
          !attendees.hidden;
      });
    });

  form.addEventListener('submit', async e => {
    e.preventDefault();

    error.textContent = '';

    if (!form.reportValidity()) return;

    const data =
      Object.fromEntries(
        new FormData(form)
      );

    data.attending =
      data.attending === 'yes';

    data.attendees =
      Number(data.attendees);

    const button =
      form.querySelector('button');

    button.disabled = true;
    button.textContent =
      'Enviando…';

    try {
      const response =
        await fetch(
          '/api/respond',
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json'
            },
            body:
              JSON.stringify(data)
          }
        );

      const output =
        await response.json();

      if (!response.ok) {
        throw Error(
          output.error
        );
      }

      form.hidden = true;

      const thanks =
        document.querySelector(
          '#thanks'
        );

      thanks.hidden = false;

      thanks.querySelector('h2')
        .textContent =
        output.attending
          ? '¡Gracias!'
          : 'Gracias por avisarnos.';

      thanks.querySelector('p')
        .textContent =
        output.attending
          ? 'Nos hace mucha ilusión compartir este día contigo.'
          : 'Sentimos que no puedas acompañarnos; esperamos compartir muchos momentos más contigo.';
    } catch (err) {
      error.textContent =
        err.message ||
        'No se ha podido enviar la confirmación. Inténtalo de nuevo.';

      button.disabled = false;
      button.textContent =
        'Enviar confirmación';
    }
  });
}

const albumForm =
  document.querySelector(
    '#album-form'
  );

const albumResult =
  document.querySelector(
    '#album-result'
  );

if (albumForm) {
  albumForm.addEventListener(
    'submit',
    async e => {
      e.preventDefault();

      albumResult.textContent =
        '';

      const button =
        albumForm.querySelector(
          'button[type="submit"]'
        );

      button.disabled = true;
      button.textContent =
        'Enviando recuerdos…';

      try {
        const data =
          new FormData(
            albumForm
          );

        const response =
          await fetch(
            '/api/album/photos',
            {
              method: 'POST',
              body: data
            }
          );

        const output =
          await response.json();

        if (!response.ok) {
          throw Error(
            output.error
          );
        }

        albumForm.reset();

        albumResult.textContent =
          '¡Gracias! Tus recuerdos han sido enviados y los revisaremos antes de publicarlos.';

        albumResult.classList.add(
          'success'
        );
      } catch (err) {
        albumResult.textContent =
          err.message ||
          'No se han podido enviar los recuerdos.';

        albumResult.classList.add(
          'error'
        );
      } finally {
        button.disabled = false;
        button.textContent =
          'Compartir recuerdos';
      }
    }
  );
}

async function loadAlbum() {
  const gallery =
    document.querySelector(
      '#album-gallery'
    );

  if (!gallery) return;

  try {
    const response =
      await fetch(
        '/api/album'
      );

    if (!response.ok) return;

    const data =
      await response.json();

    if (
      !data.photos ||
      !data.photos.length
    ) {
      gallery.hidden = true;
      return;
    }

    gallery.hidden = false;

    gallery.innerHTML =
      data.photos.map(photo => {
        const message =
          photo.message
            ? '<p>' +
              escapeHtml(
                photo.message
              ) +
              '</p>'
            : '';

        return (
          '<article class="album-photo">' +
          '<img src="' +
          photo.url +
          '" alt="Recuerdo compartido por ' +
          escapeHtml(
            photo.guest_name
          ) +
          '" loading="lazy">' +
          '<div class="album-photo-info">' +
          '<strong>' +
          escapeHtml(
            photo.guest_name
          ) +
          '</strong>' +
          message +
          '</div>' +
          '</article>'
        );
      }).join('');
  } catch (_) {
  }
}

function escapeHtml(value) {
  return String(
    value ?? ''
  ).replace(
    /[&<>'"]/g,
    char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    })[char]
  );
}

const observer =
  new IntersectionObserver(
    entries =>
      entries.forEach(entry => {
        if (
          entry.isIntersecting
        ) {
          entry.target.classList.add(
            'visible'
          );
        }
      }),
    {
      threshold: 0.12
    }
  );

document
  .querySelectorAll('.reveal')
  .forEach(el =>
    observer.observe(el)
  );

loadAlbum();
