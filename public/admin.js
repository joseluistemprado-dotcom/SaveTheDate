const $ = s =>
  document.querySelector(s);

const esc = v =>
  String(v ?? '').replace(
    /[&<>'"]/g,
    c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[c])
  );

async function api(url, opts) {
  const response =
    await fetch(url, opts);

  const json =
    response.headers
      .get('content-type')
      ?.includes('json')
      ? await response.json()
      : null;

  if (!response.ok) {
    throw Error(
      json?.error ||
      'No se ha podido completar la acción.'
    );
  }

  return json;
}

function date(value) {
  return value
    ? new Intl.DateTimeFormat(
        'es-ES',
        {
          dateStyle: 'short',
          timeStyle: 'short'
        }
      ).format(
        new Date(value + 'Z')
      )
    : '—';
}

function renderCards(stats) {
  const cards = [
    ['Invitados', stats.total],
    ['Confirmados', stats.confirmed],
    ['No asisten', stats.declined],
    ['Pendientes', stats.pending],
    [
      'Personas que asistirán',
      stats.people
    ]
  ];

  $('#cards').innerHTML =
    cards
      .map(
        ([name, value]) =>
          '<article>' +
          '<b>' +
          value +
          '</b>' +
          '<span>' +
          name +
          '</span>' +
          '</article>'
      )
      .join('');
}

function item(row) {
  return (
    esc(row.first_name) +
    ' ' +
    esc(row.last_name) +
    (
      row.attending
        ? ' — Confirmada · ' +
          row.attendees +
          ' ' +
          (
            row.attendees === 1
              ? 'persona'
              : 'personas'
          )
        : ' — No asistirá'
    )
  );
}

async function load() {
  const data =
    await api(
      '/api/admin/dashboard'
    );

  renderCards(data.stats);

  $('#pending').innerHTML =
    data.pending.length
      ? data.pending
          .map(
            x =>
              '<li>' +
              esc(x.first_name) +
              ' ' +
              esc(x.last_name) +
              '</li>'
          )
          .join('')
      : '<li>No quedan invitados pendientes.</li>';

  $('#recent').innerHTML =
    data.recent.length
      ? data.recent
          .map(
            x =>
              '<li>' +
              item(x) +
              '<br><small>' +
              date(x.created_at) +
              '</small></li>'
          )
          .join('')
      : '<li>Todavía no hay respuestas.</li>';

  await loadGuests();
  await loadAlbum();
}

async function loadGuests() {
  const params =
    new URLSearchParams({
      status: $('#filter').value,
      search: $('#search').value,
      order: $('#order').value
    });

  const data =
    await api(
      '/api/admin/guests?' +
      params
    );

  renderCards(data.stats);

  $('#guest-rows').innerHTML =
    data.rows
      .map(row => {
        const status =
          !row.response_id
            ? '<span class="status pending">Pendiente</span>'
            : row.attending
              ? '<span class="status yes">Confirmada</span>'
              : '<span class="status no">No asistirá</span>';

        return (
          '<tr>' +
          '<td>' +
          esc(row.first_name) +
          '</td>' +
          '<td>' +
          esc(row.last_name) +
          '</td>' +
          '<td>' +
          status +
          '</td>' +
          '<td>' +
          (
            row.response_id
              ? row.attendees || '—'
              : '—'
          ) +
          '</td>' +
          '<td>' +
          esc(row.comments || '—') +
          '</td>' +
          '<td>' +
          date(row.created_at) +
          '</td>' +
          '</tr>'
        );
      })
      .join('') ||
    '<tr><td colspan="6">No se han encontrado invitados.</td></tr>';
}

async function loadAlbum() {
  const status =
    $('#album-filter').value;

  const data =
    await api(
      '/api/admin/album?status=' +
      encodeURIComponent(status)
    );

  const stats =
    data.stats || {};

  $('#album-stats').innerHTML =
    '<span>Total: <b>' +
    (stats.total || 0) +
    '</b></span>' +
    '<span>Pendientes: <b>' +
    (stats.pending || 0) +
    '</b></span>' +
    '<span>Publicados: <b>' +
    (stats.approved || 0) +
    '</b></span>' +
    '<span>Rechazados: <b>' +
    (stats.rejected || 0) +
    '</b></span>';

  if (!data.photos.length) {
    $('#album-list').innerHTML =
      '<p class="album-empty">No hay recuerdos en esta categoría.</p>';
    return;
  }

  $('#album-list').innerHTML =
    data.photos
      .map(photo => {
        const action =
          photo.status === 'pending'
            ? (
              '<div class="album-actions">' +
              '<button class="button album-approve" data-id="' +
              photo.id +
              '">✓ Aprobar</button>' +
              '<button class="plain album-reject" data-id="' +
              photo.id +
              '">Rechazar</button>' +
              '</div>'
            )
            : (
              '<div class="album-status">' +
              (
                photo.status === 'approved'
                  ? '✓ Publicado'
                  : '✕ Rechazado'
              ) +
              '</div>'
            );

        return (
          '<article class="album-admin-card">' +
          '<a href="' +
          photo.url +
          '" target="_blank" rel="noopener">' +
          '<img src="' +
          photo.url +
          '" alt="Recuerdo de ' +
          esc(photo.guest_name) +
          '" loading="lazy">' +
          '</a>' +
          '<div class="album-admin-info">' +
          '<strong>' +
          esc(photo.guest_name) +
          '</strong>' +
          (
            photo.message
              ? '<p>' +
                esc(photo.message) +
                '</p>'
              : ''
          ) +
          '<small>' +
          date(photo.created_at) +
          '</small>' +
          action +
          '</div>' +
          '</article>'
        );
      })
      .join('');

  document
    .querySelectorAll(
      '.album-approve'
    )
    .forEach(button => {
      button.onclick = () =>
        reviewAlbum(
          button.dataset.id,
          'approve'
        );
    });

  document
    .querySelectorAll(
      '.album-reject'
    )
    .forEach(button => {
      button.onclick = () =>
        reviewAlbum(
          button.dataset.id,
          'reject'
        );
    });
}

async function reviewAlbum(
  id,
  action
) {
  try {
    await api(
      '/api/admin/album/' +
      id +
      '/' +
      action,
      {
        method: 'POST'
      }
    );

    await loadAlbum();
  } catch (error) {
    alert(error.message);
  }
}

$('#login-form')
  .addEventListener(
    'submit',
    async e => {
      e.preventDefault();

      const form =
        e.currentTarget;

      try {
        await api(
          '/api/admin/login',
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json'
            },
            body:
              JSON.stringify(
                Object.fromEntries(
                  new FormData(form)
                )
              )
          }
        );

        $('#login').hidden = true;
        $('#dashboard').hidden = false;
        $('#logout').hidden = false;

        await load();
      } catch (error) {
        $('.login .form-error')
          .textContent =
          error.message;
      }
    }
  );

$('#logout').onclick =
  async () => {
    await api(
      '/api/admin/logout',
      {
        method: 'POST'
      }
    );

    location.reload();
  };

['filter', 'order']
  .forEach(id => {
    $('#' + id).onchange =
      loadGuests;
  });

$('#album-filter').onchange =
  loadAlbum;

let timer;

$('#search').oninput =
  () => {
    clearTimeout(timer);

    timer = setTimeout(
      loadGuests,
      250
    );
  };

$('#export').onclick =
  () =>
    location =
      '/api/admin/export.csv';

$('#print').onclick =
  () => print();

$('#copy-pending').onclick =
  async () => {
    const data =
      await api(
        '/api/admin/guests?status=pending'
      );

    await navigator.clipboard.writeText(
      data.rows
        .map(
          x =>
            x.first_name +
            ' ' +
            x.last_name
        )
        .join('\n')
    );

    $('#copy-pending')
      .textContent =
      '¡Lista copiada!';

    setTimeout(
      () =>
        $('#copy-pending')
          .textContent =
          'Copiar lista',
      1500
    );
  };

$('#import').onclick =
  async () => {
    try {
      const data =
        await api(
          '/api/admin/import',
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json'
            },
            body:
              JSON.stringify({
                csv:
                  $('#csv').value
              })
          }
        );

      $('#import-result')
        .textContent =
        ' ' +
        data.count +
        ' invitados añadidos.';

      $('#csv').value = '';

      await load();
    } catch (error) {
      $('#import-result')
        .textContent =
        error.message;
    }
  };

api('/api/admin/me')
  .then(data => {
    if (data.authenticated) {
      $('#login').hidden = true;
      $('#dashboard').hidden = false;
      $('#logout').hidden = false;
      load();
    }
  });
