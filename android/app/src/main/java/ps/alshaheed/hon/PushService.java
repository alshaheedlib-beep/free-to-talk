package ps.alshaheed.hon;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/** Receives "someone replied" notifications from the هون server. */
public class PushService extends FirebaseMessagingService {

    @Override
    public void onNewToken(String token) {
        getSharedPreferences("hon", MODE_PRIVATE).edit().putString("push_token", token).apply();
    }

    /** When the app is open, Android doesn't show the notification by itself — we do. */
    @Override
    public void onMessageReceived(RemoteMessage msg) {
        RemoteMessage.Notification n = msg.getNotification();
        if (n == null) return;
        String url = msg.getData().get("url");
        show(this, n.getTitle(), n.getBody(), url);
    }

    static void show(Context ctx, String title, String body, String url) {
        MainActivity.ensureChannel(ctx);
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (url != null) open.putExtra("url", url);
        PendingIntent pi = PendingIntent.getActivity(ctx, (int) System.currentTimeMillis(), open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notif = new Notification.Builder(ctx, "replies")
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(Color.parseColor("#FCA311"))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build();
        ctx.getSystemService(NotificationManager.class).notify((int) System.currentTimeMillis(), notif);
    }
}
