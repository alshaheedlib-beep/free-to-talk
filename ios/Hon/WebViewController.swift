import UIKit
import WebKit
import CoreLocation
import CryptoKit

/// "هون" for iPhone: a thin shell around https://talk.alshaheed.ps.
/// Everything comes from the server, so every update reaches installed apps right away.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, CLLocationManagerDelegate {

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
        window.HonNative = { deviceId: function () { return '\(Self.deviceHash())'; }, platform: function () { return 'ios'; } };
        """
        config.userContentController.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
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

        // Ask for location once at app level, so the page can use GPS.
        location.delegate = self
        if location.authorizationStatus == .notDetermined { location.requestWhenInUseAuthorization() }

        web.load(URLRequest(url: Self.appURL))
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
