let qs = document.querySelector.bind(document);
let qsa = document.querySelectorAll.bind(document);

function clear() {
  qs('#root').innerHTML = '';
}

function append(str, root = qs('#root')) {
  let tpl = document.createElement('template');
  tpl.innerHTML = str;
  root.appendChild(tpl.content);
}

function sanitize(string) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
  };
  const reg = /[&<>"'/]/gi;
  return string.replace(reg, (match) => map[match]);
}

function getColor(name) {
  switch (name) {
    case 'green':
      return 'bg-green-300';
    case 'blue':
      return 'bg-blue-300';
    case 'red':
      return 'bg-red-300';
    case 'orange':
      return 'bg-orange-300';
    case 'yellow':
      return 'bg-yellow-300';
    case 'teal':
      return 'bg-teal-300';
    case 'purple':
      return 'bg-purple-300';
    case 'pink':
      return 'bg-pink-300';
  }
  return 'bg-gray-100';
}

const buttonClasses = 'h-12 sm:h-10 rounded focus:ring-2 focus:ring-blue-600 text-white';
const classes = {
  buttonPrimary: `${buttonClasses} bg-blue-600`,
  buttonSecondary: `${buttonClasses} bg-gray-400`,
  buttonDanger: `${buttonClasses} bg-red-600`,
  textInput: 'h-12 px-4 shadow-sm border border-gray-300 rounded',
  select: 'h-12 rounded shadow-sm border border-gray-300 text-gray-500',
}

let uiState = {
  offline: false,
  editingTodo: null,
  isAddingType: false,
  isDeletingType: false,
  activeProfileName: null,
  showingStyleSettings: false,
};

let _syncTimer = null;
function backgroundSync() {
  _syncTimer = setInterval(async () => {
    // Don't sync if an input is focused, otherwise if changes come in
    // we will clear the input (since everything is rerendered :))
    if (document.activeElement === document.body) {
      try {
        await sync();
        setOffline(false);
      } catch (e) {
        if (e.message === 'network-failure') {
          setOffline(true);
        } else {
          throw e;
        }
      }
    }
  }, 4000);
}

function setOffline(flag) {
  if (flag !== uiState.offline) {
    uiState.offline = flag;
    setSyncingEnabled(!flag);
    render();
  }
}

let _scrollTop = 0;
function saveScroll() {
  let scroller = qs('#scroller');
  if (scroller) {
    _scrollTop = scroller.scrollTop;
  }
}

function restoreScroll() {
  let scroller = qs('#scroller');
  if (scroller) {
    scroller.scrollTop = _scrollTop;
  }
}

let _activeElement = null;
function saveActiveElement() {
  let el = document.activeElement;
  _activeElement = el.id
    ? '#' + el.id
    : el.className
    ? '.' +
      el.className
        .replace(/ ?hover\:[^ ]*/g, '')
        .replace(/ /g, '.')
        .replace(/:/g, '\\:')
        .replace(/.$/, '')
    : null;
}

function restoreActiveElement() {
  const autofocusElements = qsa('[autofocus]');
  if (autofocusElements && autofocusElements.length === 1) {
    autofocusElements[0].focus();
  } else if (_activeElement) {
    let elements = qsa(_activeElement);
    // Cheap focus management: only re-focus if there's a single
    // element, otherwise we don't know which one was focused
    if (elements.length === 1) {
      elements[0].focus();
    }
  }
}

async function renderTodoTypes({ className = '', showBlank = true } = {}) {
  return `
    <select
      name="types"
      class="flex-grow ${classes.select} mx-1 sm:mx-2 mb-3 ${className}"
    >
      ${showBlank ? '<option value="">Select type...</option>' : ''}
      ${(await getTodoTypes()).map((type) => `<option value="${type.id}">${type.name}</option>`)}
      <option value="add-type">Add type...</option>
      <option value="delete-type">Delete type...</option>
    </select>
  `;
}

async function renderProfileNames() {
  return `
    <label for="profiles" class="flex justify-between items-center mb-4 w-32 mr-7">
      <span class="text-gray-500">Profile:</span>
      <select name="profiles" onchange="onStyleProfileChange()" class="${classes.select}">
        ${(await getAllProfileNames()).map(
          (profile) => `<option ${uiState.activeProfileName === profile.name ? 'selected' : ''}>${profile.name}</option>`
        )}
        <option value="add-new-profile">Add new profile...</option>
      </select>
    </label>
    
  `;
}

function renderTodos({ root, todos, isDeleted = false }) {
  todos.forEach((todo) => {
    append(
      // prettier-ignore
      `
        <div class="todo-item p-2 rounded flex" data-id="${todo.id}">
          <input type="checkbox" ${todo.done ? 'checked' : ''} class="checkbox mr-4 h-6 w-6 rounded" data-id="${todo.id}" />
          <div class="flex-grow flex items-center">
            <div class="${isDeleted ? 'line-through' : ''}">${sanitize(todo.name)}</div>
            <div class="text-sm rounded ${todo.type ? getColor(todo.type.color) : ''} px-2 ml-3">
              ${todo.type ? sanitize(todo.type.name) : ''}
            </div>
          </div>
          <select
            class="p-0 focus:outline-none border-0"
            style="background-image: url(&quot;./img/options-icon.svg&quot;);"
          >
            <option value=""></option>
            <option value="edit-todo">Edit</option>
            <option value="delete-todo">Delete</option>
          </select>
          <button class="btn-edit hover:bg-gray-400 px-2 rounded" data-id="${todo.id}">✏️</button>
          <button class="btn-delete ml-1 hover:bg-gray-400 px-2 rounded" data-id="${todo.id}">${isDeleted ? '♻️' : '🗑'}</button>
        </div>
      `,
      root
    );
  });
}

async function render() {
  document.documentElement.style.height = '100%';
  document.body.style.height = '100%';

  saveScroll();
  saveActiveElement();

  let root = qs('#root');
  root.style.height = '100%';

  let { offline, editingTodo, isAddingType, isDeletingType, showingStyleSettings } = uiState;

  clear();

  // prettier-ignore
  append(`
    <div class="flex flex-col h-full">
      <div
        class="fixed w-screen p-2 z-10 bg-gradient-to-br from-green-400 to-blue-500 font-sans text-lg font-bold text-white shadow-md flex justify-center"
      >
        <div class="max-w-screen-md flex items-center flex-grow justify-between">
          <div class="flex items-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" stroke-width="1.5" stroke="#fff" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
              <path d="M3.5 5.5l1.5 1.5l2.5 -2.5" />
              <path d="M3.5 11.5l1.5 1.5l2.5 -2.5" />
              <path d="M3.5 17.5l1.5 1.5l2.5 -2.5" />
              <line x1="11" y1="6" x2="20" y2="6" />
              <line x1="11" y1="12" x2="20" y2="12" />
              <line x1="11" y1="18" x2="20" y2="18" />
            </svg>
            <h3 class="ml-1">SideSync To-Do Demo</h3>
          </div>
          <button id="btn-show-style-modal">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" stroke-width="1.5" stroke="#fff" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
              <path d="M12 21a9 9 0 1 1 0 -18a9 8 0 0 1 9 8a4.5 4 0 0 1 -4.5 4h-2.5a2 2 0 0 0 -1 3.75a1.3 1.3 0 0 1 -1 2.25" />
              <circle cx="7.5" cy="10.5" r=".5" fill="currentColor" />
              <circle cx="12" cy="7.5" r=".5" fill="currentColor" />
              <circle cx="16.5" cy="10.5" r=".5" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>

      <div id="scroller" class="flex flex-col flex-grow items-center pt-4 px-4 mt-12 relative">
        <div class="w-full max-w-screen-md">
          <form id="add-form" class="flex flex-wrap">
            <input
              type="text"
              placeholder="Enter todo..."
              class="flex-grow mb-3 mx-1 sm:mx-2 ${classes.textInput}"
            />
            ${await renderTodoTypes()}
            <button
              id="btn-add-todo"
              class="flex-grow sm:flex-grow-0 h-12 mx-1 sm:mx-2 px-4 sm:px-8 bg-green-600 text-white rounded shadow 
                focus:outline-none focus:ring-2 focus:ring-blue-600"
            >Add</button>
          </form>

          <div class="px-2">
            <h2 class="text-lg mt-2">To Do:</h2>
            <div id="todos"></div>

            <h2 class="text-lg mt-6">Deleted:</h2>
            <div class="mt-8" id="deleted-todos"></div>
          </div>
        </div>
      </div>

      <div class="fixed w-screen bottom-0 flex justify-center bg-gray-200 border-gray-400 border-t">
        <div class="max-w-screen-md">
          <button id="btn-offline-simulate" class="text-sm hover:bg-gray-300 px-2 py-1 rounded ${offline ? 'text-blue-700' : 'text-red-700'}">${offline ? 'Go online' : 'Simulate offline'}</button>

          <button id="btn-sync" class="m-4 mr-6 ${offline ? 'bg-red-600' : 'bg-blue-600'} text-white rounded p-2">
          Sync ${offline ? '(offline)' : ''}
          </button>
        </div>
      </div>
    </div>
  `);

  renderTodos({ root: qs('#todos'), todos: await getAllTodos() });
  renderTodos({
    root: qs('#deleted-todos'),
    todos: await getAllTodos(true),
    isDeleted: true,
  });

  if (editingTodo) {
    append(`
      <div class="absolute bottom-0 left-0 right-0 top-0 flex items-center justify-center" style="background-color: rgba(.2, .2, .2, .4)">
        <div class="bg-white p-8">
          <h2 class="text-lg font-bold mb-4">Edit todo</h2>
          <div class="flex">
            <input value="${sanitize(
              editingTodo.name
            )}" class="shadow border border-gray-300 mr-2 flex-grow p-2 rounded" />
            <button id="btn-edit-save" class="rounded p-2 bg-blue-600 text-white mr-2focus:ring-2 focus:ring-blue-600 ">Save</button>
            <button id="btn-edit-cancel" class="rounded p-2 bg-gray-200 focus:ring-2 focus:ring-blue-600">Cancel</button>
          </div>

          ${editingTodo.tombstone === 1 ? '<button id="btn-edit-undelete" class="pt-4 text-sm">Undelete</button>' : ''}
        </div>
      <div>
    `);
  }

  if (isAddingType) {
    append(`
      <div class="absolute bottom-0 left-0 right-0 top-0 pt-16 flex justify-center items-start bg-gray-500 bg-opacity-40">
        <div class="flex-grow max-w-sm mx-4 p-4 bg-white rounded shadow-xl">
          <h2 class="text-lg font-bold mb-4">Add To-Do Type</h2>
          <div class="flex flex-col">
            <input
              autofocus
              type="text"
              placeholder="Enter type (e.g., &quot;Groceries&quot;)..."
              class="${classes.textInput} flex-grow mx-2 mb-4 p-2" />
              <div class="mx-2 flex justify-end">
                <button
                  id="btn-edit-cancel"
                  class="${classes.buttonSecondary} px-8"
                >Cancel</button>
                <button
                  id="btn-edit-save"
                  class="${classes.buttonPrimary} ml-4 px-8"
                >Save</button>
              </div>
          </div>
        </div>
      </div>
    `);
  }

  if (isDeletingType) {
    append(`
      <div class="absolute bottom-0 left-0 right-0 top-0 flex items-center justify-center>
        <div class="bg-white p-8">
          <h2 class="text-lg font-bold mb-4">Delete todo type</h2>
          <div class="pb-2">
            Delete ${await renderTodoTypes({ className: 'selected' })} and
            merge into ${await renderTodoTypes({
              className: 'merge',
              showBlank: true,
            })}
          </div>

          <div class="flex mt-2">
            <button id="btn-edit-delete" class="${classes.buttonDanger}  p-2 mr-2">Delete</button>
            <button id="btn-edit-cancel" class="${classes.buttonSecondary} p-2">Cancel</button>
          </div>
        </div>
      </div>
    `);
  }

  if (showingStyleSettings) {
    append(`
      <div class="absolute bottom-0 left-0 right-0 top-0 pt-16 flex justify-center items-start bg-gray-500 bg-opacity-40">
        <div class="flex-grow max-w-sm mx-4 p-4 bg-white rounded shadow-xl">
          <h2 class="text-lg font-bold mb-4">Preferences</h2>
          <div class="flex flex-col">
            ${await renderProfileNames()}
            <label for="bg-color-setting" class="flex justify-between items-center mb-4">
              <span class="text-gray-500 flex-grow">Background Color:</span>
              <input
                type="text"
                name="bg-color-setting"
                value="${qs('#root').style.backgroundColor}"
                class="${classes.select} w-32"
                disabled
              />
              <span class="ml-2" onclick="onBgColorSettingClick()">✏️</span>
            </label>
            <label for="font-size-setting" class="flex justify-between items-center mb-4">
              <span class="text-gray-500 flex-grow">Font Size:</span>
              <input
                type="text"
                name="font-size-setting"
                value="${qs('html').style.fontSize}"
                class="${classes.select} w-32"
                disabled
              />
              <span class="ml-2" onclick="onFontSizeSettingClick()">✏️</span>
            </label>
            <button
              onClick="closeStyleSettings()"
              class="${classes.buttonPrimary} mt-4 px-8"
            >Done</button>
          </div>
        </div>
      </div>
    `);
  }

  addEventHandlers();
  restoreScroll();
  restoreActiveElement();
}

function addEventHandlers() {
  qs('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let [nameNode, typeNode] = e.target.elements;
    let name = nameNode.value;
    let type = typeNode.selectedOptions[0].value;

    if (type.includes('-type')) {
      return;
    }

    nameNode.value = '';
    typeNode.selectedIndex = 0;

    if (name === '') {
      alert("Todo can't be blank. C'mon!");
      return;
    }

    await addTodo({ name, type, order: await getNumTodos() });
    render();
  });

  qs('#btn-sync').addEventListener('click', async (e) => {
    sync();
  });

  qs('#btn-offline-simulate').addEventListener('click', () => {
    if (uiState.offline) {
      setOffline(false);
      backgroundSync();
    } else {
      setOffline(true);
      clearInterval(_syncTimer);
    }
  });

  for (let editBtn of qsa('.todo-item .btn-edit')) {
    editBtn.addEventListener('click', async (e) => {
      let todo = await getTodo(editBtn.dataset.id);
      uiState.editingTodo = todo;
      render();
    });
  }

  for (let todoNode of qsa('.todo-item .checkbox')) {
    todoNode.addEventListener('click', async (e) => {
      updateTodo({ done: e.target.checked }, todoNode.dataset.id);
      render();
    });
  }

  for (let deleteBtn of qsa('.todo-item .btn-delete')) {
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      let todo = await getTodo(deleteBtn.dataset.id);
      if (todo.deleted) {
        undeleteTodo(todo.id);
      } else {
        deleteTodo(todo.id);
      }
      render();
    });
  }

  if (uiState.editingTodo) {
    qs('#btn-edit-save').addEventListener('click', (e) => {
      let input = e.target.parentNode.querySelector('input');
      let value = input.value;
      updateTodo({ name: value }, uiState.editingTodo.id);
      uiState.editingTodo = null;
      render();
    });

    if (qs('#btn-edit-undelete')) {
      qs('#btn-edit-undelete').addEventListener('click', (e) => {
        let input = e.target.parentNode.querySelector('input');
        let value = input.value;

        undeleteTodo(uiState.editingTodo.id);
        uiState.editingTodo = null;
        render();
      });
    }
  } else if (uiState.isAddingType) {
    qs('#btn-edit-save').addEventListener('click', (e) => {
      let input = e.target.parentNode.parentNode.querySelector('input');
      let value = input.value;

      let colors = ['green', 'blue', 'red', 'orange', 'yellow', 'teal', 'purple', 'pink'];

      addTodoType({
        name: value,
        color: colors[(Math.random() * colors.length) | 0],
      });
      uiState.isAddingType = false;
      render();
    });
  } else if (uiState.isDeletingType) {
    qs('#btn-edit-delete').addEventListener('click', (e) => {
      let modal = e.target.parentNode;
      let selected = qs('select.selected').selectedOptions[0].value;
      let merge = qs('select.merge').selectedOptions[0].value;

      if (selected === merge) {
        alert('Cannot merge type into itself');
        return;
      }

      deleteTodoType(selected, merge !== '' ? merge : null);

      uiState.isDeletingType = false;
      render();
    });
  }

  let cancel = qs('#btn-edit-cancel');
  if (cancel) {
    cancel.addEventListener('click', () => {
      uiState.editingTodo = null;
      uiState.isAddingType = false;
      uiState.isDeletingType = false;
      render();
    });
  }

  qs('select[name=types]').addEventListener('change', async (e) => {
    if (e.target.value === 'add-type') {
      uiState.isAddingType = true;
      render();
    } else if (e.target.value === 'delete-type') {
      uiState.isDeletingType = true;
      render();
    }
  });

  qs('#btn-show-style-modal').addEventListener('click', async (e) => {
    uiState.showingStyleSettings = true;
    render();
  });
}

async function onStyleProfileChange(e) {
  const selection = qs('select[name=profiles]').value;
  if (selection === 'add-new-profile') {
    const newVal = prompt('ADD PROFILE\n(shared across devices if syncing enabled)\n\nProfile name:');
    if (newVal.trim() === '') {
      alert(`Ignoring invalid profile name. Please specify a non-empty value.`);
      return;
    } else {
      await addProfileName(newVal);
    }
  } else {
    await updateActiveProfileName(selection);
    uiState.activeProfileName = selection;
    await loadAndApplyProfileSettings();
  }

  render();
}



async function onBgColorSettingClick() {
  const currentVal = qs('#root').style.backgroundColor;
  const newVal = prompt('BACKGROUND COLOR\n(applies to all devices if syncing enabled)\n\nColor:', currentVal);
  if (newVal) {
    await updateBgColorSetting(uiState.activeProfileName, newVal);
    setBgColor(newVal);
    render();
  }
}

async function onFontSizeSettingClick() {
  const currentVal = parseFloat(qs('html').style.fontSize || 16);
  const newVal = parseFloat(
    prompt('BASE FONT SIZE\n(only applies to current device)\n\nPlease specify number (e.g., "12.5"):', currentVal)
  );
  if (!newVal || newVal === NaN) {
    alert(`Ignoring invalid font size. Please specify a floating point number (e.g., 12.5).`);
  } else {
    await updateFontSizeSetting(uiState.activeProfileName, newVal);
    setFontSize(newVal);
  }
}

function closeStyleSettings() {
  uiState.showingStyleSettings = false;
  render();
}

function setBgColor(color) {
  qs('#root').style.backgroundColor = color;
}

function setFontSize(size) {
  qs('html').style.fontSize = `${size}px`;
}

async function loadAndApplyProfileSettings(profileName) {
  setBgColor((await getBgColorSetting(uiState.activeProfileName)) || 'white');
  setFontSize(await getFontSizeSetting(uiState.activeProfileName));
}

(async () => {
  const activeProfileName = await getActiveProfileName();
  if (activeProfileName) {
    uiState.activeProfileName = activeProfileName;
    // If a profile exists, try loading profile-specific settings
    await loadAndApplyProfileSettings();
  } else {
    const defaultProfileName = 'Default';
    await addProfileName(defaultProfileName);
    await updateActiveProfileName(defaultProfileName);
    uiState.activeProfileName = defaultProfileName;
  }

  render();
})();

let _syncMessageTimer = null;

let gdriveSyncProvider = null;

function setupSync() {
  // This will check local storage for Google Drive access token, etc. If none
  // exists, it'll dynamically add a <script> element to the document for loading
  // the Google API JavaScript client, and then proceed to launch the OAuth login
  // pop-up.
  if (IDBSideSync.plugins.googledrive.needsSetup()) {
    console.warn('todo: setup google sync...');
  }
  // IDBSideSync.plugins.googledrive.setup((syncProvider) => {
  //   gdriveSyncProvider = syncProvider;
  //   sync();
  // });
}

function sync() {
  if (gdriveSyncProvider) {
    // IDBSideSync.sync(gdriveSyncProvider);
  } else {
    setupSync();
  }
}
// onSync(hasChanged => {
//   render();

//   let message = qs('#up-to-date');
//   message.style.transition = 'none';
//   message.style.opacity = 1;

//   clearTimeout(_syncMessageTimer);
//   _syncMessageTimer = setTimeout(() => {
//     message.style.transition = 'opacity .7s';
//     message.style.opacity = 0;
//   }, 1000);
// });

// sync().then(() => {
//   if (getTodoTypes().length === 0) {
//     // Insert some default types
//     insertTodoType({ name: 'Personal', color: 'green' });
//     insertTodoType({ name: 'Work', color: 'blue' });
//   }
// });
// backgroundSync();
