<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useReportStore } from '@/entities/report'
import {
  CloudError,
  authError,
  signInWithPassword,
  setAccountPassword,
  equal,
  loadDocument,
  permitted,
  readCache,
  reconcile,
  saveDocument,
  sendCode,
  session,
  signOut,
  writeCache,
  type Document,
} from './cloud'

const store = useReportStore()
const email = ref('')
const password = ref('')
const newPassword = ref('')
const repeatPassword = ref('')
const showPasswordSetup = ref(false)
const passwordNotice = ref('')
const passwordError = ref('')
const codeSent = ref(false)
const loggedIn = ref(false)
const ready = ref(false)
const busy = ref(false)
const dirty = ref(false)
const conflict = ref(false)
const error = ref(sessionStorage.getItem('kpo-login-error') ?? '')
sessionStorage.removeItem('kpo-login-error')
const status = ref('Проверяем вход…')
const userId = ref('')
const lockHeld = ref(false)
let version = 0
let applying = false
let running = false
let remoteConflict: Document | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let poll: ReturnType<typeof setInterval> | undefined
let releaseLock: (() => void) | undefined
const blocked = computed(() => conflict.value || !ready.value)

function localSave() {
  try {
    writeCache(userId.value, { payload: store.exportState(), version, dirty: dirty.value })
    return true
  } catch {
    error.value = 'Не удалось сохранить копию в браузере. Освободи место; пока не закрывай страницу.'
    return false
  }
}
function apply(payload: ReturnType<typeof store.exportState>) {
  applying = true
  store.replaceState(payload)
  applying = false
}
function failure(reason: unknown) {
  if (reason instanceof CloudError && reason.status === 401) {
    ready.value = false
    loggedIn.value = false
    status.value = 'Войди снова. Несохранённые изменения останутся на этом устройстве.'
  } else {
    status.value = dirty.value ? 'Есть изменения, ожидающие отправки' : 'Нет связи с облаком'
  }
  error.value = reason instanceof Error ? reason.message : 'Не удалось соединиться'
}

async function initialize() {
  const current = session()
  if (!current) {
    status.value = 'Войди, чтобы открыть свою КПО'
    return
  }
  if (!lockHeld.value && navigator.locks) {
    void navigator.locks.request('kpo-editor', { ifAvailable: true }, async (lock) => {
      if (!lock) {
        status.value = 'КПО уже открыта в другой вкладке. Закрой её и обнови эту страницу.'
        return
      }
      lockHeld.value = true
      await initialize()
      await new Promise<void>((resolve) => {
        releaseLock = resolve
      })
    })
    return
  }
  userId.value = current.user.id
  email.value = current.user.email ?? ''
  loggedIn.value = true
  busy.value = true
  error.value = ''
  try {
    if (!(await permitted())) throw new Error('Этот аккаунт не имеет доступа к книге КПО')
    const remote = await loadDocument()
    const cache = readCache(userId.value)
    const action = reconcile(cache, remote)
    if (action === 'pending' || action === 'conflict') {
      apply(cache!.payload)
      version = cache!.version
      dirty.value = true
      remoteConflict = remote
      conflict.value = action === 'conflict'
    } else if (remote) {
      apply(remote.payload)
      version = remote.version
      dirty.value = false
    } else {
      version = 0
      dirty.value = true
    }
    ready.value = true
    localSave()
    status.value = dirty.value ? 'Ожидает сохранения' : 'Сохранено в облаке'
    if (!conflict.value) await synchronize()
  } catch (reason) {
    failure(reason)
  } finally {
    busy.value = false
  }
}

async function synchronize() {
  if (running || !ready.value || conflict.value) return
  running = true
  error.value = ''
  try {
    if (dirty.value) {
      status.value = 'Сохраняем…'
      const snapshot = store.exportState()
      const saved = await saveDocument(snapshot, version)
      version = saved.version
      dirty.value = !equal(snapshot, store.exportState())
      localSave()
      status.value = dirty.value ? 'Сохраняем новые изменения…' : 'Сохранено в облаке'
      if (dirty.value) timer = setTimeout(() => void synchronize(), 750)
    } else {
      const remote = await loadDocument()
      // The user may have started editing while the request was in flight.
      if (!dirty.value && remote && remote.version !== version) {
        apply(remote.payload)
        version = remote.version
        localSave()
      }
      status.value = dirty.value ? 'Ожидает сохранения' : 'Сохранено в облаке'
    }
  } catch (reason) {
    if (reason instanceof CloudError && reason.code === '40001') {
      conflict.value = true
      status.value = 'Записи изменились на другом устройстве'
      try {
        remoteConflict = await loadDocument()
      } catch {
        remoteConflict = null
      }
    } else {
      failure(reason)
    }
  } finally {
    running = false
  }
}

watch(
  () => store.exportState(),
  () => {
    if (applying || !ready.value) return
    dirty.value = true
    status.value = 'Ожидает сохранения'
    localSave()
    clearTimeout(timer)
    timer = setTimeout(() => void synchronize(), 750)
  },
  { deep: true, flush: 'sync' },
)

function downloadCopy() {
  const data = { version: 1, exportedAt: new Date().toISOString(), data: store.exportState() }
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `kpo-copy-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function resolveConflict(keepLocal: boolean) {
  busy.value = true
  try {
    const latest = await loadDocument()
    if (!latest) throw new Error('Не удалось загрузить облачную версию')
    // Always refresh before resolving; an additional concurrent save still fails atomically.
    remoteConflict = latest
    if (!keepLocal) {
      downloadCopy()
      apply(latest.payload)
    }
    version = remoteConflict.version
    dirty.value = keepLocal
    conflict.value = false
    localSave()
    await synchronize()
  } catch (reason) {
    failure(reason)
  } finally {
    busy.value = false
  }
}
async function passwordLogin() {
  busy.value = true
  error.value = ''
  try {
    await signInWithPassword(email.value, password.value)
    password.value = ''
    codeSent.value = false
    await initialize()
  } catch (reason) {
    status.value = 'Не удалось войти'
    error.value = authError(reason)
  } finally {
    busy.value = false
  }
}
async function savePassword() {
  passwordError.value = ''
  if (newPassword.value.length < 12) {
    passwordError.value = 'Минимум 12 символов.'
    return
  }
  if (newPassword.value !== repeatPassword.value) {
    passwordError.value = 'Пароли не совпадают.'
    return
  }
  busy.value = true
  try {
    await setAccountPassword(newPassword.value)
    newPassword.value = ''
    repeatPassword.value = ''
    showPasswordSetup.value = false
    passwordNotice.value = 'Пароль сохранён. Теперь можно входить с любого устройства по почте и паролю.'
  } catch (reason) {
    passwordError.value = authError(reason)
  } finally {
    busy.value = false
  }
}
function closePasswordSetup() {
  showPasswordSetup.value = false
  newPassword.value = ''
  repeatPassword.value = ''
  passwordError.value = ''
}
async function requestCode() {
  busy.value = true
  error.value = ''
  try {
    await sendCode(email.value)
    codeSent.value = true
    status.value = 'Письмо отправлено. Открой ссылку из письма на этом устройстве.'
  } catch (reason) {
    status.value = 'Письмо не отправлено'
    error.value = authError(reason)
  } finally {
    busy.value = false
  }
}
async function logout() {
  if (dirty.value || running) return
  busy.value = true
  ready.value = false
  await signOut(userId.value)
  location.reload()
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
function onVisible() {
  if (document.visibilityState === 'visible') void synchronize()
}
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('online', synchronize)
  document.addEventListener('visibilitychange', onVisible)
  void initialize()
  poll = setInterval(() => void synchronize(), 15000)
})
onBeforeUnmount(() => {
  clearTimeout(timer)
  clearInterval(poll)
  releaseLock?.()
  window.removeEventListener('beforeunload', beforeUnload)
  window.removeEventListener('online', synchronize)
  document.removeEventListener('visibilitychange', onVisible)
})
</script>

<template>
  <main v-if="!loggedIn || !ready" class="CloudLogin no-print">
    <section class="CloudCard">
      <div class="CloudMark">КПО</div>
      <h1>Твоя книга доходов</h1>
      <p>Одни и те же записи на компьютере и телефоне.</p>
      <p role="status">{{ status }}</p>
      <form v-if="!loggedIn" @submit.prevent="passwordLogin">
        <label for="cloud-email">Электронная почта</label>
        <input id="cloud-email" v-model="email" type="email" autocomplete="username" required />
        <label for="cloud-password">Пароль</label>
        <input id="cloud-password" v-model="password" type="password" autocomplete="current-password" required />
        <button :disabled="busy">{{ busy ? 'Подожди…' : 'Войти' }}</button>
        <button type="button" class="CloudSecondary" :disabled="busy || !email.trim()" @click="requestCode">
          Первый вход / забыл пароль — получить ссылку
        </button>
      </form>
      <p v-if="codeSent && !loggedIn">
        Открой ссылку из письма на этом устройстве. После входа нажми «Задать пароль». Для писем действует лимит; вход
        по паролю писем не требует.
      </p>
      <button v-if="codeSent && !loggedIn" type="button" :disabled="busy" @click="initialize">
        Я уже открыл ссылку
      </button>
      <button v-if="loggedIn && !ready" :disabled="busy" @click="initialize">Повторить подключение</button>
      <p v-if="error" class="CloudError" role="alert">{{ error }}</p>
      <small>Вход доступен владельцу книги. На общем компьютере нажимай «Выйти» после работы.</small>
    </section>
  </main>
  <template v-else>
    <div class="CloudBar no-print">
      <span role="status">{{ status }}</span>
      <button :disabled="busy" @click="synchronize">Синхронизировать</button>
      <button
        :disabled="busy"
        @click="
          showPasswordSetup = true;
          passwordNotice = ''
        "
      >
        Задать пароль
      </button>
      <button :disabled="dirty || busy" @click="logout">Выйти</button>
      <p v-if="passwordNotice" role="status">{{ passwordNotice }}</p>
      <p v-if="error" class="CloudError" role="alert">
        {{ error }}. Изменения остаются на этом устройстве; не закрывай страницу до сохранения.
      </p>
    </div>
    <section v-if="showPasswordSetup" class="CloudPassword no-print" aria-label="Задать пароль">
      <h2>Пароль для входа на всех устройствах</h2>
      <p>Для {{ email }}. Это пароль от КПО, а не от базы данных Supabase.</p>
      <form @submit.prevent="savePassword">
        <label for="new-password">Новый пароль (минимум 12 символов)</label>
        <input
          id="new-password"
          v-model="newPassword"
          type="password"
          autocomplete="new-password"
          minlength="12"
          required
        />
        <label for="repeat-password">Повтори пароль</label>
        <input
          id="repeat-password"
          v-model="repeatPassword"
          type="password"
          autocomplete="new-password"
          minlength="12"
          required
        />
        <button :disabled="busy">{{ busy ? 'Сохраняем…' : 'Сохранить пароль' }}</button>
        <button type="button" class="CloudSecondary" :disabled="busy" @click="closePasswordSetup">Отмена</button>
        <p v-if="passwordError" class="CloudError" role="alert">{{ passwordError }}</p>
      </form>
    </section>
    <section v-if="conflict" class="CloudConflict no-print" role="alert">
      <h2>Есть изменения на двух устройствах</h2>
      <p>Чтобы не потерять записи, автоматическое сохранение приостановлено. Выбери версию, которую нужно оставить.</p>
      <button :disabled="busy" @click="downloadCopy">Скачать копию этого устройства</button>
      <button :disabled="busy" @click="resolveConflict(false)">
        Загрузить облачную версию (местная скачается копией)
      </button>
      <button :disabled="busy" @click="resolveConflict(true)">Заменить облачную версию этой</button>
    </section>
    <div :inert="blocked"><slot /></div>
  </template>
</template>

<style scoped>
.CloudPassword {
  max-width: 480px;
  margin: 24px auto;
  padding: 24px;
  background: white;
  border: 1px solid #9bb5a9;
  border-radius: 16px;
}
.CloudLogin {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: #eef4f1;
  color: #18372c;
}
.CloudCard {
  width: min(100%, 440px);
  box-sizing: border-box;
  padding: 32px;
  border-radius: 20px;
  background: white;
  box-shadow: 0 12px 40px #123c2412;
}
.CloudMark {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.15em;
  color: #2c7960;
}
h1 {
  font-size: 28px;
  line-height: 1.15;
  margin: 16px 0;
}
p {
  line-height: 1.5;
}
form {
  display: grid;
  gap: 12px;
  margin: 24px 0;
}
input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 12px;
  border: 1px solid #9bb5a9;
  border-radius: 8px;
  font: inherit;
  font-size: 16px;
  color: #18372c;
  background: white;
}
button {
  cursor: pointer;
  border: 0;
  border-radius: 8px;
  padding: 11px 16px;
  background: #246c52;
  color: white;
  font: inherit;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.CloudSecondary {
  background: #edf3f0;
  color: #246c52;
}
small {
  display: block;
  line-height: 1.5;
  color: #587266;
}
.CloudBar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 20px;
  background: #edf5f0;
  color: #18372c;
}
.CloudBar > span {
  flex: 1;
}
.CloudBar p {
  flex-basis: 100%;
  margin: 0;
}
.CloudConflict {
  margin: 20px;
  padding: 20px;
  background: #fff3d8;
  color: #453915;
  border-radius: 12px;
}
.CloudConflict button {
  margin: 6px;
}
.CloudError {
  color: #a32626;
  overflow-wrap: anywhere;
}
@media (max-width: 480px) {
  .CloudCard {
    padding: 22px;
  }
  .CloudBar {
    padding: 10px;
    gap: 8px;
  }
  .CloudBar > span {
    flex-basis: 100%;
  }
}
@media print {
  .no-print {
    display: none !important;
  }
}
</style>
