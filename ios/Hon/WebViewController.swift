import UIKit
import WebKit
import CoreLocation
import CryptoKit

/// "هون" for iPhone: a thin shell around https://talk.alshaheed.ps.
/// Everything comes from the server, so every update reaches installed apps right away.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, CLLocationManagerDelegate, WKScriptMessageHandler {

    private static let appURL = URL(string: "https://talk.alshaheed.ps/")!
    private static let appHost = "talk.alshaheed.ps"
    private static let navy = UIColor(red: 0x14/255, green: 0x21/255, blue: 0x3d/255, alpha: 1)
    private static let paper = UIColor(red: 0xf5/255, green: 0xf2/255, blue: 0xea/255, alpha: 1)

    private var web: WKWebView!
    private let location = CLLocationManager()

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.navy

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        // Same bridge as Android: window.HonNative.deviceId() / platform()
        let bridge = """
        window.HonNative = { deviceId: function () { return '\(Self.deviceHash())'; }, platform: function () { return 'ios'; },
          shareImage: function (data, text) { window.webkit.messageHandlers.honShare.postMessage({ data: data, text: text }); } };
        """
        config.userContentController.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // The page's navigator.geolocation is answered by the app itself, so iPhone asks for location
        // once (for "هون"), not a second time for the website.
        let geo = """
        (function () {
          var waiting = {}, seq = 0;
          window.__honGeo = function (id, ok, lat, lng, acc, code, msg) {
            var w = waiting[id]; if (!w) return; delete waiting[id];
            if (ok) w.ok({ coords: { latitude: lat, longitude: lng, accuracy: acc, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
            else if (w.err) w.err({ code: code, message: msg, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
          };
          var geo = {
            getCurrentPosition: function (ok, err) { var id = ++seq; waiting[id] = { ok: ok, err: err }; window.webkit.messageHandlers.honGeo.postMessage(id); },
            watchPosition: function (ok, err) { this.getCurrentPosition(ok, err); return 0; },
            clearWatch: function () {}
          };
          try { Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true }); } catch (e) {}
        })();
        """
        config.userContentController.addUserScript(WKUserScript(source: geo, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(self, name: "honGeo")
        config.userContentController.add(self, name: "honShare")
        config.applicationNameForUserAgent = "HonApp/iOS"

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.backgroundColor = Self.paper
        web.isOpaque = false
        web.scrollView.bounces = false
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyNearestTenMeters

        web.load(URLRequest(url: Self.appURL))
    }

    // MARK: - Location for the page

    private var geoWaiting: [Int] = []

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "honShare", let body = message.body as? [String: Any],
           let b64 = body["data"] as? String, let data = Data(base64Encoded: b64), let image = UIImage(data: data) {
            let text = body["text"] as? String ?? ""
            let sheet = UIActivityViewController(activityItems: [image, text], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = view
            present(sheet, animated: true)
            return
        }
        guard message.name == "honGeo", let id = message.body as? Int else { return }
        geoWaiting.append(id)
        switch location.authorizationStatus {
        case .notDetermined: location.requestWhenInUseAuthorization()   // answer arrives in the delegate below
        case .denied, .restricted: answerGeo(nil, code: 1, message: "denied")
        default: location.requestLocation()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard !geoWaiting.isEmpty else { return }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: manager.requestLocation()
        case .denied, .restricted: answerGeo(nil, code: 1, message: "denied")
        default: break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        answerGeo(locations.last, code: 0, message: "")
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let denied = (error as? CLError)?.code == .denied
        answerGeo(nil, code: denied ? 1 : 2, message: error.localizedDescription)
    }

    private func answerGeo(_ loc: CLLocation?, code: Int, message: String) {
        let ids = geoWaiting; geoWaiting.removeAll()
        for id in ids {
            let js: String
            if let l = loc {
                js = "window.__honGeo(\(id), true, \(l.coordinate.latitude), \(l.coordinate.longitude), \(l.horizontalAccuracy))"
            } else {
                js = "window.__honGeo(\(id), false, 0, 0, 0, \(code), 'location')"
            }
            web.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    /// One-way hash of the vendor id: lets a ban stick to this phone without revealing anything.
    private static func deviceHash() -> String {
        let id = UIDevice.current.identifierForVendor?.uuidString ?? ""
        guard !id.isEmpty else { return "" }
        let digest = SHA256.hash(data: Data("hon:ps.alshaheed.hon:\(id)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    // Keep our own pages inside the app; everything else (WhatsApp, phone, maps) opens outside.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == "https", url.host == Self.appHost { return decisionHandler(.allow) }
        if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return decisionHandler(.allow) }
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showOffline()
    }

    private func showOffline() {
        let html = """
        <!doctype html><html dir='rtl'><meta name='viewport' content='width=device-width,initial-scale=1'>
        <body style='margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f5f2ea;color:#14213d;font-family:-apple-system,sans-serif;text-align:center;padding:24px;box-sizing:border-box'>
        <div style='font-size:56px'>📍</div><h2 style='margin:12px 0 6px'>ما في اتصال</h2>
        <p style='color:#6b7489;margin:0 0 22px'>تأكد من الإنترنت وجرّب مرة ثانية</p>
        <a href='\(Self.appURL.absoluteString)' style='border-radius:14px;padding:14px 30px;background:#fca311;color:#3d2600;font-size:17px;font-weight:bold;text-decoration:none'>إعادة المحاولة</a></body></html>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    // Native alert/confirm for the page (used by the admin page's confirmations).
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "تمام", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "إلغاء", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "نعم", style: .destructive) { _ in completionHandler(true) })
        present(a, animated: true)
    }
}
