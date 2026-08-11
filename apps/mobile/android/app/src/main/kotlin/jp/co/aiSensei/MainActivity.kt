package jp.co.aiSensei

import android.content.Context
import android.media.AudioManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "jp.co.aiSensei/decorative_audio",
        ).setMethodCallHandler { call, result ->
            if (call.method != "prepare") {
                result.notImplemented()
                return@setMethodCallHandler
            }

            val audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            // Android のマナーモードは通常 media stream までは消さないが、
            // この声かけは必須情報ではないので、端末を黙らせた意図を広く尊重する。
            // ringer / media の値は読むだけで、音量を上げたりモードを戻したりしない。
            val ringerAllowsSound = audio.ringerMode == AudioManager.RINGER_MODE_NORMAL
            val mediaHasVolume = audio.getStreamVolume(AudioManager.STREAM_MUSIC) > 0
            result.success(ringerAllowsSound && mediaHasVolume)
        }
    }
}
