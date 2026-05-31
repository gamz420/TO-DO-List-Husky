(() => {
  // --------------------------
  // Utils
  // --------------------------
  const uid = () =>
    crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const formatBytes = (bytes) => {
    const units = ["B", "KB", "MB", "GB"];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  };

  const formatDateTime = (ts) => new Date(ts).toLocaleString();

  // --------------------------
  // Storage: tasks in localStorage
  // files in IndexedDB
  // --------------------------
  const LS_KEY = "todo-husky:v1";

  /** @type {{id:string,title:string,completed:boolean,createdAt:number,updatedAt:number,attachmentIds:string[]}[]} */
  let tasks = [];

  function loadTasks() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      tasks = raw ? JSON.parse(raw) : [];
    } catch {
      tasks = [];
    }
  }

  function saveTasks() {
    localStorage.setItem(LS_KEY, JSON.stringify(tasks));
  }

  // --------------------------
  // IndexedDB (files)
  // Store: files (keyPath id), index taskId
  // Record: { id, taskId, name, type, size, lastModified, blob }
  // --------------------------
  const DB_NAME = "todo_files_db";
  const DB_VERSION = 2;
  const STORE = "files";

  /** @type {IDBDatabase|null} */
  let db = null;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const d = req.result;

        // 1) создать store если его не было
        if (!d.objectStoreNames.contains(STORE)) {
          const store = d.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("taskId", "taskId", { unique: false });
          return;
        }

        // 2) если store уже есть — создаём индекс, если его не было
        const store = req.transaction.objectStore(STORE);
        if (!store.indexNames.contains("taskId")) {
          store.createIndex("taskId", "taskId", { unique: false });
        }
      };

      req.onsuccess = () => {
        db = req.result;
        resolve(db);
      };

      req.onerror = () => reject(req.error);
    });
  }

  function tx(mode) {
    if (!db) throw new Error("DB is not open");
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  function dbPutFile(record) {
    return new Promise((resolve, reject) => {
      const req = tx("readwrite").put(record);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  function dbGetFile(id) {
    return new Promise((resolve, reject) => {
      const req = tx("readonly").get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  function dbDeleteFile(id) {
    return new Promise((resolve, reject) => {
      const req = tx("readwrite").delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  function dbGetFilesByTaskId(taskId) {
    return new Promise((resolve, reject) => {
      const store = tx("readonly");
      const idx = store.index("taskId");
      const req = idx.getAll(taskId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbDeleteFilesByTaskId(taskId) {
    const files = await dbGetFilesByTaskId(taskId);
    await Promise.all(files.map((f) => dbDeleteFile(f.id)));
  }

  // --------------------------
  // UI
  // --------------------------
  const addForm = document.getElementById("addForm");
  const taskInput = document.getElementById("taskInput");
  const searchInput = document.getElementById("searchInput");
  const list = document.getElementById("list");
  const tpl = document.getElementById("taskTemplate");
  const totalChip = document.getElementById("totalChip");
  const doneChip = document.getElementById("doneChip");
  const clearCompletedBtn = document.getElementById("clearCompletedBtn");

  /** objectUrl cache for file downloads (attachmentId -> objectUrl) */
  const urlCache = new Map();

  function revokeUrl(attachmentId) {
    const u = urlCache.get(attachmentId);
    if (u) {
      URL.revokeObjectURL(u);
      urlCache.delete(attachmentId);
    }
  }

  function setStats() {
    totalChip.textContent = `Всего: ${tasks.length}`;
    const done = tasks.filter((t) => t.completed).length;
    doneChip.textContent = `Готово: ${done}`;
    clearCompletedBtn.disabled = done === 0;
  }

  function getFilteredTasks() {
    const q = (searchInput.value || "").trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((t) => t.title.toLowerCase().includes(q));
  }

  async function render() {
    setStats();
    list.innerHTML = "";

    const filtered = getFilteredTasks();
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.style.padding = "14px 0 2px";
      empty.textContent = "Пока нет задач по этому запросу.";
      list.appendChild(empty);
      return;
    }

    for (const task of filtered) {
      const node = tpl.content.firstElementChild.cloneNode(true);

      node.dataset.id = task.id;
      node.classList.toggle("done", task.completed);

      const titleEl = node.querySelector('[data-role="title"]');
      const metaEl = node.querySelector('[data-role="meta"]');
      const editRow = node.querySelector('[data-role="editRow"]');
      const editInput = node.querySelector('[data-role="editInput"]');
      const attachmentsEl = node.querySelector('[data-role="attachments"]');
      const fileInput = node.querySelector('[data-role="fileInput"]');

      titleEl.textContent = task.title;
      metaEl.textContent = `Обновлено: ${formatDateTime(task.updatedAt)}`;

      // attachments
      attachmentsEl.innerHTML = "";
      if (task.attachmentIds && task.attachmentIds.length > 0) {
        // берём из DB реальные записи
        const fileRecords = await dbGetFilesByTaskId(task.id);
        // отсортируем по имени (опционально)
        fileRecords.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

        for (const f of fileRecords) {
          const row = document.createElement("div");
          row.className = "file";
          row.dataset.fileId = f.id;

          // objectUrl cache
          let objectUrl = urlCache.get(f.id);
          if (!objectUrl) {
            objectUrl = URL.createObjectURL(f.blob);
            urlCache.set(f.id, objectUrl);
          }

          const a = document.createElement("a");
          a.href = objectUrl;
          a.download = f.name;
          a.textContent = f.name;

          const size = document.createElement("span");
          size.className = "muted small";
          size.textContent = formatBytes(f.size || 0);

          const del = document.createElement("button");
          del.className = "btn btn-ghost";
          del.type = "button";
          del.textContent = "✕";
          del.title = "Удалить файл";
          del.dataset.action = "delete-file";
          del.dataset.fileId = f.id;

          row.appendChild(a);
          row.appendChild(size);
          row.appendChild(del);

          attachmentsEl.appendChild(row);
        }
      }

      // file input change
      fileInput.addEventListener("change", async (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        await addFilesToTask(task.id, files);
        e.target.value = "";
        await render();
      });

      // store references for edit
      editInput.value = task.title;
      editRow.classList.add("hidden");

      list.appendChild(node);
    }
  }

  function findTask(id) {
    return tasks.find((t) => t.id === id) || null;
  }

  function updateTask(id, patch) {
    const i = tasks.findIndex((t) => t.id === id);
    if (i === -1) return;
    tasks[i] = { ...tasks[i], ...patch, updatedAt: Date.now() };
    saveTasks();
  }

  async function addFilesToTask(taskId, fileList) {
    const task = findTask(taskId);
    if (!task) return;

    const ids = [];
    for (const file of Array.from(fileList)) {
      const fileId = uid();
      ids.push(fileId);

      await dbPutFile({
        id: fileId,
        taskId,
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
        blob: file, // File — это Blob, можно хранить в IndexedDB
      });
    }

    const nextIds = [...(task.attachmentIds || []), ...ids];
    updateTask(taskId, { attachmentIds: nextIds });
  }

  async function deleteTask(taskId) {
    // удалить файлы из DB
    await dbDeleteFilesByTaskId(taskId);

    // освободить objectUrl
    const toRevoke = Array.from(urlCache.keys());
    for (const id of toRevoke) revokeUrl(id);

    tasks = tasks.filter((t) => t.id !== taskId);
    saveTasks();
  }

  async function deleteFile(taskId, fileId) {
    const task = findTask(taskId);
    if (!task) return;

    await dbDeleteFile(fileId);
    revokeUrl(fileId);

    const next = (task.attachmentIds || []).filter((id) => id !== fileId);
    updateTask(taskId, { attachmentIds: next });
  }

  function enterEdit(li) {
    const taskId = li.dataset.id;
    const task = findTask(taskId);
    if (!task) return;

    const titleEl = li.querySelector('[data-role="title"]');
    const editRow = li.querySelector('[data-role="editRow"]');
    const editInput = li.querySelector('[data-role="editInput"]');

    titleEl.classList.add("hidden");
    editRow.classList.remove("hidden");
    editInput.value = task.title;
    editInput.focus();
  }

  function exitEdit(li) {
    const titleEl = li.querySelector('[data-role="title"]');
    const editRow = li.querySelector('[data-role="editRow"]');

    titleEl.classList.remove("hidden");
    editRow.classList.add("hidden");
  }

  async function saveEdit(li) {
    const taskId = li.dataset.id;
    const task = findTask(taskId);
    if (!task) return;

    const editInput = li.querySelector('[data-role="editInput"]');
    const v = (editInput.value || "").trim();
    if (!v) return;

    updateTask(taskId, { title: v });
    await render();
  }

  // --------------------------
  // Events
  // --------------------------
  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = (taskInput.value || "").trim();
    if (!title) return;

    const now = Date.now();
    tasks.unshift({
      id: uid(),
      title,
      completed: false,
      createdAt: now,
      updatedAt: now,
      attachmentIds: [],
    });

    taskInput.value = "";
    saveTasks();
    await render();
  });

  searchInput.addEventListener("input", () => {
    render();
  });

  clearCompletedBtn.addEventListener("click", async () => {
    const toDelete = tasks.filter((t) => t.completed);
    for (const t of toDelete) {
      await dbDeleteFilesByTaskId(t.id);
    }
    // очистим кеш урлов (проще)
    for (const id of Array.from(urlCache.keys())) revokeUrl(id);

    tasks = tasks.filter((t) => !t.completed);
    saveTasks();
    await render();
  });

  // Event delegation for list
  list.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;

    const action = btn.dataset.action;
    const li = btn.closest(".item");
    if (!li) return;

    const taskId = li.dataset.id;

    if (action === "toggle") {
      const t = findTask(taskId);
      if (!t) return;
      updateTask(taskId, { completed: !t.completed });
      await render();
      return;
    }

    if (action === "delete") {
      await deleteTask(taskId);
      await render();
      return;
    }

    if (action === "edit") {
      enterEdit(li);
      return;
    }

    if (action === "cancel") {
      exitEdit(li);
      return;
    }

    if (action === "save") {
      await saveEdit(li);
      return;
    }

    if (action === "attach") {
      const fileInput = li.querySelector('[data-role="fileInput"]');
      fileInput.click();
      return;
    }

    if (action === "delete-file") {
      const fileId = btn.dataset.fileId;
      await deleteFile(taskId, fileId);
      await render();
      return;
    }
  });

  // Enter to save in edit input
  list.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const input = e.target.closest('[data-role="editInput"]');
    if (!input) return;
    const li = input.closest(".item");
    if (!li) return;
    await saveEdit(li);
  });

  // --------------------------
  // Init
  // --------------------------
  (async function init() {
    loadTasks();
    await openDb();
    await render();
  })();
})();
