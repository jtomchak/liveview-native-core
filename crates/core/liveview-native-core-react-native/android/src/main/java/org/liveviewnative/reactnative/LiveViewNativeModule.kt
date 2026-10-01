package org.liveviewnative.reactnative

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import io.github.expo.modules.v2.react.ReactExpoContext
import io.github.expo.modules.v2.Event
import io.github.expo.modules.v2.ExpoModule
import io.github.expo.modules.v2.JS
import io.github.expo.modules.v2.Module
import java.lang.ref.WeakReference
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URI
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.phoenixframework.liveviewnative.channel.EventPayload
import org.phoenixframework.liveviewnative.channel.Json
import org.phoenixframework.liveviewnative.channel.Number as JsonNumber
import org.phoenixframework.liveviewnative.channel.Payload
import org.phoenixframework.liveviewnative.core.*

@ExpoModule(name = "LiveViewNative")
class LiveViewNativeModule : Module() {
  private val sessions = ConcurrentHashMap<String, Session>()
  private val stores = ConcurrentHashMap<String, NativeCookieStore>()
  private val signingOut = mutableSetOf<String>()
  private val lifecycleLock = Any()
  // The worker expires when idle, including after a JavaScript runtime reload.
  private val updates = ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, LinkedBlockingQueue()).apply {
    allowCoreThreadTimeOut(true)
  }
  private val cleanupScope = CoroutineScope(Dispatchers.IO)

  // V2 fires this hook both when the final listener unsubscribes and when its
  // runtime closes. Native shutdown must run off the JavaScript thread.
  @Event(name = "onUpdate")
  val onUpdate = event<Map<String, Any?>>(onStopObserving = { releaseUnobservedSessions() })

  @JS
  suspend fun connect(sessionId: String, url: String) {
    withContext(Dispatchers.IO) {
      val origin = normalizedOrigin(url)
      val store = synchronized(lifecycleLock) {
        check(origin !in signingOut) { "Origin is signing out" }
        stores.getOrPut(origin) {
          NativeCookieStore((context as ReactExpoContext).reactContext.applicationContext, origin)
        }
      }
      store.checkFailure()
      val session = synchronized(lifecycleLock) {
        check(origin !in signingOut) { "Origin is signing out" }
        check(stores[origin] === store) { "Origin session changed while connecting" }
        check(onUpdate.isObserved) { "Subscribe to onUpdate before connecting" }
        Session(sessionId, origin, store).also {
          check(sessions.putIfAbsent(sessionId, it) == null) { "Session already exists: $sessionId" }
        }
      }
      val builder = LiveViewClientBuilder()
      val callbacks = Callbacks(this@LiveViewNativeModule, session)
      try {
        builder.setFormat(Platform.ReactNative)
        builder.setPersistenceProvider(store)
        builder.setNavigationHandler(NavigationCallbacks(session))
        builder.setLiveChannelEventHandler(callbacks)
        enqueue(session) { publish(session, "connecting") }
        val client = builder.connect(url, ClientConnectOpts())
        val accepted = synchronized(session) {
          if (session.active.get() && sessions[sessionId] === session && onUpdate.isObserved) {
            session.client = client
            true
          } else false
        }
        if (!accepted) {
          client.shutdown()
          client.destroy()
          error("Session disconnected while connecting")
        }
        store.checkFailure()
        // The status callback publishes initial connection state and owns
        // document replacement, including reconnects and initial errors.
      } catch (error: Exception) {
        enqueue(session) { publish(session, "error", error.message ?: error.toString()) }
        if (store.hasFailure) dispose(session, false)
        // A cancelled promise may mean its JS runtime disappeared; reclaim
        // resources even when the caller can no longer invoke disconnect.
        if (!onUpdate.isObserved && sessions.remove(sessionId, session)) dispose(session, false)
        throw error
      } finally {
        builder.destroy()
      }
    }
  }

  @JS
  suspend fun sendEvent(sessionId: String, event: String, valueJson: String) {
    withContext(Dispatchers.IO) {
      val session = sessions[sessionId] ?: error("Unknown session: $sessionId")
      val client = synchronized(session) {
        check(session.active.get()) { "Session is disconnected" }
        session.client ?: error("Session is not connected")
      }
      val value = JSONObject(valueJson)
      val payload = Json.Object(mapOf(
        "type" to Json.Str("click"),
        "event" to Json.Str(event),
        "value" to jsonValue(value)
      ))
      client.call("event", Payload.JsonPayload(payload))
      session.store.checkFailure()
      Unit
    }
  }

  @JS
  suspend fun callEvent(sessionId: String, event: String, valueJson: String): String =
    withContext(Dispatchers.IO) {
      val session = sessions[sessionId] ?: error("Session is disconnected")
      val client = navigationClient(sessionId)
      val generation = session.documentGeneration
      try {
        require(event.isNotEmpty() && event.toByteArray(Charsets.UTF_8).size <= 128 &&
          valueJson.toByteArray(Charsets.UTF_8).size <= 16_384) { "Invalid command payload" }
        val payload = Json.Object(mapOf(
          "type" to Json.Str("click"), "event" to Json.Str(event), "value" to jsonValue(JSONObject(valueJson))
        ))
        val wireReply = client.call("event", Payload.JsonPayload(payload))
        session.store.checkFailure()
        val reply = jsonReplyString(wireReply)
        require(reply.toByteArray(Charsets.UTF_8).size <= 16_384) { "Invalid command reply" }
        reply
      } catch (_: Exception) {
        if (session.store.hasFailure) enqueue(session) {
          if (session.documentGeneration == generation) publish(session, "error", "Secure cookie storage failed")
        }
        // Command failures remain retryable without changing connection status.
        error("Command event failed")
      }
    }

  @JS
  suspend fun sendForm(sessionId: String, event: String, encodedValue: String, cid: Double?): String =
    withContext(Dispatchers.IO) {
      require(event.isNotEmpty() && event.toByteArray(Charsets.UTF_8).size <= 128 &&
        encodedValue.toByteArray(Charsets.UTF_8).size <= 262_144) { "Invalid form event payload" }
      val session = sessions[sessionId] ?: error("Session is disconnected")
      val client = navigationClient(sessionId)
      val fields = mutableMapOf<String, Json>(
        "type" to Json.Str("form"), "event" to Json.Str(event), "value" to Json.Str(encodedValue)
      )
      if (cid != null) {
        require(cid.isFinite() && cid >= 1 && cid <= 9_007_199_254_740_991.0 && cid % 1.0 == 0.0) {
          "Invalid form component target"
        }
        fields["cid"] = Json.Numb(JsonNumber.PosInt(cid.toULong()))
      }
      val generation = session.documentGeneration
      try {
        // A successful channel reply is not proof that a business record was saved.
        val reply = client.call("event", Payload.JsonPayload(Json.Object(fields)))
        session.store.checkFailure()
        jsonReplyString(reply)
      } catch (_: Exception) {
        enqueue(session) {
          if (session.documentGeneration == generation) publish(session, "error", "Form event failed")
        }
        error("Form event failed")
      }
    }

  @JS
  suspend fun uploadFile(sessionId: String, fieldName: String, uri: String, fileName: String, mimeType: String) {
    withContext(Dispatchers.IO) {
      val session = sessions[sessionId] ?: error("Session is disconnected")
      val client = navigationClient(sessionId)
      val generation = session.documentGeneration
      try {
        require(fieldName.isNotEmpty() && fieldName.toByteArray(Charsets.UTF_8).size <= 128 &&
          mimeType in setOf("image/png", "text/plain")) { "Invalid upload metadata" }
        val basename = uploadBasename(fileName)
        val contents = readUpload(uri)
        check(session.active.get() && session.documentGeneration == generation && session.status == "connected") {
          "Upload document changed"
        }
        val uploadId = client.getPhxUploadId(fieldName)
        val file = LiveFile(contents, mimeType, fieldName, basename, uploadId)
        try {
          // A completed transfer still requires the server's consume/save event.
          client.uploadFiles(listOf(file))
          session.store.checkFailure()
        } finally {
          file.destroy()
        }
      } catch (_: Exception) {
        if (session.store.hasFailure) enqueue(session) {
          if (session.documentGeneration == generation) publish(session, "error", "Secure cookie storage failed")
        }
        // Paths, file names, upload tokens, and server payloads stay native.
        error("File upload failed")
      }
    }
  }

  private fun uploadBasename(fileName: String): String {
    val basename = fileName.replace('\\', '/').substringAfterLast('/')
      .replace(Regex("[^\\p{L}\\p{N}._ -]"), "_").trim('.', ' ')
    require(basename.isNotEmpty() && basename.toByteArray(Charsets.UTF_8).size <= 128) { "Invalid upload name" }
    return basename
  }

  private fun readUpload(address: String): ByteArray {
    val uri = Uri.parse(address)
    val appContext = (context as ReactExpoContext).reactContext.applicationContext
    val stream = when (uri.scheme) {
      "file" -> {
        require(uri.authority.isNullOrEmpty() || uri.authority == "localhost") { "Invalid file URI" }
        val file = File(uri.path ?: error("Invalid file URI"))
        require(file.isFile) { "Invalid upload file" }
        file.inputStream()
      }
      "content" -> appContext.contentResolver.openInputStream(uri) ?: error("Upload file unavailable")
      else -> error("Invalid upload URI")
    }
    return stream.use { input ->
      val output = ByteArrayOutputStream()
      val buffer = ByteArray(65_536)
      val maximum = 2 * 1024 * 1024
      while (output.size() <= maximum) {
        val read = input.read(buffer, 0, minOf(buffer.size, maximum + 1 - output.size()))
        if (read == -1) break
        check(read > 0) { "Upload file unreadable" }
        output.write(buffer, 0, read)
      }
      require(output.size() in 1..maximum) { "Invalid upload size" }
      output.toByteArray()
    }
  }

  @JS
  suspend fun cancelUpload(sessionId: String, fieldName: String, entryRef: String) {
    withContext(Dispatchers.IO) {
      val session = sessions[sessionId] ?: error("Session is disconnected")
      val client = navigationClient(sessionId)
      val generation = session.documentGeneration
      try {
        require(fieldName.isNotEmpty() && fieldName.toByteArray(Charsets.UTF_8).size <= 128 &&
          entryRef.isNotEmpty() && entryRef.toByteArray(Charsets.UTF_8).size <= 128) { "Invalid upload cancellation" }
        client.cancelUpload(fieldName)
        check(session.active.get() && session.documentGeneration == generation && session.status == "connected") {
          "Upload document changed"
        }
        val payload = Json.Object(mapOf(
          "type" to Json.Str("click"), "event" to Json.Str("cancel_upload"),
          "value" to Json.Object(mapOf("ref" to Json.Str(entryRef)))
        ))
        client.call("event", Payload.JsonPayload(payload))
        session.store.checkFailure()
      } catch (_: Exception) {
        if (session.store.hasFailure) enqueue(session) {
          if (session.documentGeneration == generation) publish(session, "error", "Secure cookie storage failed")
        }
        error("Upload cancellation failed")
      }
    }
  }

  @JS
  suspend fun postForm(sessionId: String, url: String, fieldsJson: String) {
    withContext(Dispatchers.IO) {
      val session = sessions[sessionId] ?: error("Session is disconnected")
      submitForm(session, url, fieldsJson)
    }
  }

  @JS
  suspend fun navigate(sessionId: String, url: String, replace: Boolean) {
    withContext(Dispatchers.IO) {
      val session = sessions[sessionId] ?: error("Session is disconnected")
      require(normalizedOrigin(url) == session.origin) { "Navigation requires the same origin" }
      // Core returns after queuing; the committed route arrives through onUpdate.
      navigationClient(sessionId).navigate(url, NavOptions(action = if (replace) NavAction.REPLACE else NavAction.PUSH))
      Unit
    }
  }

  @JS
  suspend fun back(sessionId: String) {
    withContext(Dispatchers.IO) {
      navigationClient(sessionId).back(NavActionOptions())
      Unit
    }
  }

  @JS
  suspend fun forward(sessionId: String) {
    withContext(Dispatchers.IO) {
      navigationClient(sessionId).forward(NavActionOptions())
      Unit
    }
  }

  @JS
  suspend fun getNavigation(sessionId: String): String = withContext(Dispatchers.IO) {
    val session = sessions[sessionId] ?: error("Session is disconnected")
    val client = navigationClient(sessionId)
    val current = client.current()
    JSONObject().apply {
      put("url", current?.url ?: JSONObject.NULL)
      // u64 history IDs cross the JavaScript bridge as strings.
      put("historyId", current?.id?.toString() ?: JSONObject.NULL)
      put("action", synchronized(session) { session.lastNavigationAction } ?: JSONObject.NULL)
      put("canGoBack", client.canGoBack())
      put("canGoForward", client.canGoForward())
    }.toString()
  }

  private fun navigationClient(sessionId: String): LiveViewClient {
    val session = sessions[sessionId] ?: error("Session is disconnected")
    return synchronized(session) {
      check(session.active.get() && session.status == "connected") { "Session is not connected" }
      session.client ?: error("Session is not connected")
    }
  }

  private class NavigationCallbacks(current: Session) : NavEventHandler {
    private val session = WeakReference(current)
    override fun handleEvent(event: NavEvent): HandlerResponse {
      val current = session.get() ?: return HandlerResponse.PREVENT_DEFAULT
      val allowed = runCatching { URI(event.to.url) }.getOrNull()?.let { uri ->
          val scheme = uri.scheme?.lowercase()
          val host = uri.host?.lowercase()
          val port = if (uri.port == -1) if (scheme == "https") 443 else 80 else uri.port
          uri.userInfo == null && (scheme == "http" || scheme == "https") &&
            host != null && "$scheme://$host:$port" == current.origin
        } == true
      return synchronized(current) {
        if (!allowed || !current.active.get()) HandlerResponse.PREVENT_DEFAULT
        else {
          current.lastNavigationAction = event.event.name.lowercase()
          HandlerResponse.DEFAULT
        }
      }
    }
  }

  @JS
  suspend fun logout(sessionId: String, url: String) {
    withContext(Dispatchers.IO) {
      val session = sessions[sessionId] ?: error("Session is disconnected")
      require(normalizedOrigin(url) == session.origin) { "Authentication requires the same origin" }
      synchronized(lifecycleLock) { check(signingOut.add(session.origin)) { "Origin is signing out" } }
      try {
        var failure: Exception? = null
        try { submitForm(session, url, "{}") } catch (error: Exception) { failure = error }
        session.store.disableWrites()
        // Close all in-memory jars before clearing their durable cookie cache.
        val closing = synchronized(lifecycleLock) {
          sessions.values.filter { it.origin == session.origin }.also { list ->
            list.forEach { sessions.remove(it.id, it); it.active.set(false) }
          }
        }
        closing.forEach { current ->
          updates.execute {
            current.document?.destroy()
            current.document = null
            if (onUpdate.isObserved) publish(current, "disconnected", clearDocument = true)
          }
        }
        try {
          closing.forEach {
            try { dispose(it, false) } catch (error: Exception) { if (failure == null) failure = error }
          }
        } finally {
          session.store.removeEntry("COOKIE_CACHE")
          stores.remove(session.origin, session.store)
        }
        session.store.checkFailure()
        failure?.let { throw it }
      } finally { synchronized(lifecycleLock) { signingOut.remove(session.origin) } }
    }
  }

  private suspend fun submitForm(session: Session, url: String, fieldsJson: String) {
    require(normalizedOrigin(url) == session.origin) { "Authentication requires the same origin" }
    val fields = JSONObject(fieldsJson).let { objectValue ->
      objectValue.keys().asSequence().associateWith { key ->
        val value = objectValue.get(key)
        require(value is String) { "Authentication fields must be strings" }
        value
      }
    }
    val client = synchronized(session) {
      check(session.active.get()) { "Session is disconnected" }
      session.client ?: error("Session is not connected")
    }
    val generation = session.documentGeneration
    client.postForm(url, fields, null, null)
    // Rust schedules reconnect; wait for the response document before resolving.
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
    while (System.nanoTime() < deadline) {
      session.store.checkFailure()
      check(session.active.get()) { "Session is disconnected" }
      check(session.status != "error") { "Authentication request failed" }
      if (session.status == "connected" && session.documentGeneration > generation) return
      delay(50)
    }
    error("Authentication request timed out")
  }

  @JS
  suspend fun disconnect(sessionId: String) {
    withContext(Dispatchers.IO) {
      val session = sessions.remove(sessionId)
      if (session != null) dispose(session, true)
    }
  }

  private fun releaseUnobservedSessions() {
    val closing = synchronized(lifecycleLock) {
      if (onUpdate.isObserved) return
      sessions.values.toList().also { list ->
        list.forEach { it.active.set(false) }
        sessions.clear()
      }
    }
    cleanupScope.launch { closing.forEach { dispose(it, false) } }
  }

  private class Session(val id: String, val origin: String, val store: NativeCookieStore) {
    val active = AtomicBoolean(true)
    var client: LiveViewClient? = null
    var lastNavigationAction: String? = null
    // Document, status and revision are accessed only on the update executor.
    var document: Document? = null
    var documentIdentity: ULong? = null
    @Volatile var documentGeneration = 0L
    @Volatile var status = "connecting"
    var revision = 0L
    var callbackCount = 0L
  }

  private fun enqueue(session: Session, action: () -> Unit) {
    if (!session.active.get()) return
    try {
      updates.execute {
        if (session.active.get() && sessions[session.id] === session && onUpdate.isObserved) action()
      }
    } catch (_: RejectedExecutionException) { /* Module teardown has begun. */ }
  }

  private fun publish(session: Session, status: String, error: String? = null, clearDocument: Boolean = false) {
    session.status = if (session.store.hasFailure && !clearDocument) "error" else status
    // nanoTime is monotonic; elapsed time is independent of wall-clock changes.
    val started = System.nanoTime()
    val document = session.document?.snapshotJson()
    val snapshotMs = document?.let { (System.nanoTime() - started) / 1_000_000.0 }
    session.revision += 1
    onUpdate.emit(mapOf(
      "sessionId" to session.id,
      "revision" to session.revision,
      "documentGeneration" to session.documentGeneration,
      "status" to session.status,
      "document" to document,
      "error" to if (session.store.hasFailure) "Secure cookie storage failed" else error,
      "snapshotMs" to snapshotMs,
      "snapshotBytes" to document?.toByteArray(Charsets.UTF_8)?.size,
      "callbackCount" to session.callbackCount,
      "clearDocument" to clearDocument
    ))
    if (session.store.hasFailure && session.active.get()) cleanupScope.launch { dispose(session, false) }
  }

  private fun normalizedOrigin(address: String): String {
    val uri = URI(address)
    val scheme = uri.scheme?.lowercase()
    require(scheme == "http" || scheme == "https") { "Invalid endpoint scheme" }
    val host = uri.host?.lowercase() ?: error("Invalid endpoint host")
    require(uri.userInfo == null) { "Endpoint credentials are unsupported" }
    val port = if (uri.port == -1) if (scheme == "https") 443 else 80 else uri.port
    return "$scheme://$host:$port"
  }

  private class NativeCookieStore(context: Context, origin: String) : SecurePersistentStore {
    private val scope = MessageDigest.getInstance("SHA-256").digest(origin.toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it.toInt() and 255) }
    private val alias = "org.liveviewnative.cookies.$scope"
    private val preferences = context.getSharedPreferences("lvn.cookies.$scope", Context.MODE_PRIVATE)
    @Volatile private var failure: String? = null
    private var disabled = false
    val hasFailure: Boolean get() = failure != null
    fun checkFailure() { check(failure == null) { "Secure cookie storage failed: $failure" } }
    @Synchronized fun disableWrites() { disabled = true }

    private fun secretKey(): SecretKey {
      val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      (keys.getKey(alias, null) as? SecretKey)?.let { return it }
      return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
        init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
      }.generateKey()
    }
    @Synchronized override fun get(key: String): ByteArray? {
      if (disabled) return null
      return try {
        val encoded = preferences.getString(key, null) ?: return null
        val parts = encoded.split(":")
        require(parts.size == 2)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
        cipher.updateAAD("$scope:$key".toByteArray(Charsets.UTF_8))
        cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP))
      } catch (_: Exception) { failure = "read"; null }
    }
    @Synchronized override fun set(key: String, value: ByteArray) {
      if (disabled) return
      try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        cipher.updateAAD("$scope:$key".toByteArray(Charsets.UTF_8))
        val encrypted = cipher.doFinal(value)
        val encoded = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
          Base64.encodeToString(encrypted, Base64.NO_WRAP)
        check(preferences.edit().putString(key, encoded).commit())
      } catch (_: Exception) { failure = "write" }
    }
    @Synchronized override fun removeEntry(key: String) {
      try { check(preferences.edit().remove(key).commit()); failure = null }
      catch (_: Exception) { failure = "delete" }
    }
  }

  private fun dispose(session: Session, notify: Boolean) {
    val client = synchronized(session) {
      session.active.set(false)
      session.client.also { session.client = null }
    }
    // Synchronous shutdown also covers cancellation before a join has finished.
    client?.shutdown()
    client?.destroy()
    try {
      updates.execute {
        session.document?.destroy()
        session.document = null
        session.documentIdentity = null
        if (notify && onUpdate.isObserved && sessions[session.id] == null) {
          publish(session, "disconnected")
        }
      }
    } catch (_: RejectedExecutionException) { }
  }

  // Rust retains callback objects. Weak references prevent a client/module cycle.
  private class Callbacks(module: LiveViewNativeModule, session: Session) :
    NetworkEventHandler {
    private val module = WeakReference(module)
    private val session = WeakReference(session)

    override fun onEvent(event: EventPayload) = Unit

    override fun onStatusChange(status: LiveViewClientStatus) {
      val owner = module.get()
      val current = session.get()
      if (owner == null || current == null || !current.active.get()) {
        status.destroy()
        return
      }
      // Ownership of a new document moves into the serial update queue.
      val connected = (status as? LiveViewClientStatus.Connected)?.channelStatus
        as? MainChannelStatus.Connected
      if (connected != null) {
        val document = connected.document
        try {
          owner.updates.execute {
            if (!current.active.get() || owner.sessions[current.id] !== current || !owner.onUpdate.isObserved) {
              document.destroy()
            } else {
              val identity = document.identity()
              if (current.documentIdentity != identity) {
                current.documentGeneration += 1
                current.documentIdentity = identity
              }
              current.document?.destroy()
              current.document = document
              document.setEventHandler(DocumentCallbacks(owner, current, current.documentGeneration))
              owner.publish(current, "connected")
            }
          }
        } catch (_: RejectedExecutionException) { document.destroy() }
      } else {
        val name = when (status) {
          LiveViewClientStatus.Disconnected -> "disconnected"
          LiveViewClientStatus.Connecting -> "connecting"
          LiveViewClientStatus.Reconnecting -> "reconnecting"
          is LiveViewClientStatus.Connected -> "reconnecting"
          is LiveViewClientStatus.Error -> "error"
        }
        val error = (status as? LiveViewClientStatus.Error)?.error?.message
        owner.enqueue(current) { owner.publish(current, name, error) }
        status.destroy()
      }
    }

  }

  private class DocumentCallbacks(owner: LiveViewNativeModule, current: Session, private val generation: Long) :
    DocumentChangeHandler {
    private val module = WeakReference(owner)
    private val session = WeakReference(current)

    override fun handleDocumentChange(changeType: ChangeType, nodeRef: NodeRef, nodeData: NodeData, parent: NodeRef?) {
      nodeRef.destroy()
      parent?.destroy()
      val owner = module.get() ?: return
      val current = session.get() ?: return
      // Rust invokes this after applying patches. Never wait for JS inside Rust.
      owner.enqueue(current) {
        if (current.documentGeneration != generation) return@enqueue
        current.callbackCount += 1
        owner.publish(current, current.status)
      }
    }
  }

  private fun jsonValue(value: Any?): Json = when (value) {
    null, JSONObject.NULL -> Json.Null
    is JSONObject -> Json.Object(value.keys().asSequence().associateWith { jsonValue(value.get(it)) })
    is JSONArray -> Json.Array((0 until value.length()).map { jsonValue(value.get(it)) })
    is Boolean -> Json.Bool(value)
    is String -> Json.Str(value)
    is Int -> if (value >= 0) Json.Numb(JsonNumber.PosInt(value.toULong())) else Json.Numb(JsonNumber.NegInt(value.toLong()))
    is Long -> if (value >= 0) Json.Numb(JsonNumber.PosInt(value.toULong())) else Json.Numb(JsonNumber.NegInt(value))
    is kotlin.Number -> Json.Numb(JsonNumber.Float(value.toDouble()))
    else -> error("Unsupported JSON value")
  }

  private fun jsonReplyString(payload: Payload): String {
    val json = (payload as? Payload.JsonPayload)?.json as? Json.Object ?: error("Invalid JSON reply")
    return JSONObject(json.`object`.mapValues { replyValue(it.value) }).toString()
  }

  private fun replyValue(json: Json): Any = when (json) {
    Json.Null -> JSONObject.NULL
    is Json.Bool -> json.bool
    is Json.Str -> json.string
    is Json.Array -> JSONArray(json.array.map(::replyValue))
    is Json.Object -> JSONObject(json.`object`.mapValues { replyValue(it.value) })
    is Json.Numb -> when (val number = json.number) {
      is JsonNumber.PosInt -> {
        require(number.pos <= Long.MAX_VALUE.toULong()) { "Reply integer is out of range" }
        number.pos.toLong()
      }
      is JsonNumber.NegInt -> number.neg
      is JsonNumber.Float -> number.float
    }
  }
}
