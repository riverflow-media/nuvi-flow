const form = document.querySelector('#setup');
const error = document.querySelector('#error');
const saveButton = document.querySelector('.save');

async function load() {
  const settings = await window.personalMedia.loadSettings();
  for (const key of ['moviesPath', 'tvPath', 'baseUrl', 'port']) {
    const element = document.querySelector(`#${key}`);
    if (settings[key] !== undefined) element.value = settings[key];
  }
  document.querySelector('#startAtLogin').checked = Boolean(settings.startAtLogin);
  if (settings.hasPassword) {
    document.querySelector('#adminPassword').disabled = true;
    document.querySelector('#passwordHint').textContent = 'Your existing password is preserved. Change it from the dashboard after setup.';
  }
}

document.querySelectorAll('[data-folder]').forEach((button) => {
  button.addEventListener('click', async () => {
    const kind = button.dataset.folder;
    const selected = await window.personalMedia.chooseFolder(kind);
    if (selected) document.querySelector(kind === 'movies' ? '#moviesPath' : '#tvPath').value = selected;
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  saveButton.disabled = true;
  const result = await window.personalMedia.saveSettings({
    moviesPath: document.querySelector('#moviesPath').value,
    tvPath: document.querySelector('#tvPath').value,
    adminPassword: document.querySelector('#adminPassword').value,
    baseUrl: document.querySelector('#baseUrl').value,
    port: document.querySelector('#port').value,
    startAtLogin: document.querySelector('#startAtLogin').checked
  });
  if (!result.ok) {
    error.textContent = result.error;
    saveButton.disabled = false;
  }
});

void load();
