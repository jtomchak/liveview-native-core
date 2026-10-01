package org.liveviewnative.reactnative

import io.github.expo.modules.v2.Event
import io.github.expo.modules.v2.ExpoModule
import io.github.expo.modules.v2.JS
import io.github.expo.modules.v2.Module
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
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
      val session = synchronized(lifecycleLock) {
        check(onUpdate.isObserved) { "Subscribe to onUpdate before connecting" }
        Session(sessionId).also {
          check(sessions.putIfAbsent(sessionId, it) == null) { "Session already exists: $sessionId" }
        }
      }
      val builder = LiveViewClientBuilder()
      val callbacks = Callbacks(this@LiveViewNativeModule, session)
      try {
        builder.setFormat(Platform.ReactNative)
        builder.setLiveChannelEventHandler(callbacks)
        builder.setPatchHandler(callbacks)
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
        // The status callback publishes initial connection state and owns
        // document replacement, including reconnects and initial errors.
      } catch (error: Exception) {
        enqueue(session) { publish(session, "error", error.message ?: error.toString()) }
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
      Unit
    }
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

  private class Session(val id: String) {
    val active = AtomicBoolean(true)
    var client: LiveViewClient? = null
    // Document, status and revision are accessed only on the update executor.
    var document: Document? = null
    var status = "connecting"
    var revision = 0L
  }

  private fun enqueue(session: Session, action: () -> Unit) {
    if (!session.active.get()) return
    try {
      updates.execute {
        if (session.active.get() && sessions[session.id] === session && onUpdate.isObserved) action()
      }
    } catch (_: RejectedExecutionException) { /* Module teardown has begun. */ }
  }

  private fun publish(session: Session, status: String, error: String? = null) {
    session.status = status
    val document = session.document?.snapshotJson()
    session.revision += 1
    onUpdate.emit(mapOf(
      "sessionId" to session.id,
      "revision" to session.revision,
      "status" to status,
      "document" to document,
      "error" to error
    ))
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
        if (notify && onUpdate.isObserved && sessions[session.id] == null) {
          publish(session, "disconnected")
        }
      }
    } catch (_: RejectedExecutionException) { }
  }

  // Rust retains callback objects. Weak references prevent a client/module cycle.
  private class Callbacks(module: LiveViewNativeModule, session: Session) :
    NetworkEventHandler, DocumentChangeHandler {
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
              current.document?.destroy()
              current.document = document
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

    override fun handleDocumentChange(changeType: ChangeType, nodeRef: NodeRef, nodeData: NodeData, parent: NodeRef?) {
      nodeRef.destroy()
      parent?.destroy()
      val owner = module.get() ?: return
      val current = session.get() ?: return
      // Rust invokes this after applying patches. Never wait for JS inside Rust.
      owner.enqueue(current) { owner.publish(current, current.status) }
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
}
