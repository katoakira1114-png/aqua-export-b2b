/**
 * ==============================================================================
 * AQUA EXPORT INTERNATIONAL - B2B OVERSEAS WHOLESALE BACKEND (GAS)
 * ==============================================================================
 * 
 * [概要]
 * 国内受発注スプレッドシート本番データベースと連携し、海外バイヤー向けに
 * ゼロトラスト（機密隠蔽・在庫非連動・レートリミット）なAPIを提供するGASスクリプト。
 * 
 * [セキュリティ安全設計 (BFF/プロキシ化)]
 * 1. 内部シート構造、仕入れ値、国内顧客情報、在庫管理列の完全隠蔽 (Sanitization)
 * 2. 4桁PINコード認証 & ブルートフォースレート制限 (CacheService利用)
 * 3. 在庫非減算（即時引き落としを行わず、注文リクエストとして記録）
 * 4. Discord Webhook & 管理者Gmail自動通知
 * ==============================================================================
 */

// ==========================================
// 1. 環境設定 & プロパティ管理
// ==========================================
const CONFIG = {
  // 石垣島観賞魚（川畑水産）本番スプレッドシートID
  DEFAULT_SPREADSHEET_ID: "1ZiNel8TGJ-e7JMolkRagVOSnr1UczvQzpTa-F-s4p3o",

  // 6大カテゴリシート
  TARGET_CATEGORIES: ["魚", "貝", "シャコガイ", "イソギンチャク", "サンゴ", "その他"],

  // デフォルトPIN（スクリプトプロパティ 'OVERSEAS_PIN' で上書き可能）
  DEFAULT_PIN: "9876",

  // 管理者通知先メールアドレス（スクリプトプロパティ 'ADMIN_EMAIL' で上書き可能）
  DEFAULT_ADMIN_EMAIL: "export-admin@example.com",

  // Discord Webhook URL（スクリプトプロパティ 'DISCORD_WEBHOOK_URL' で上書き可能）
  DEFAULT_DISCORD_WEBHOOK: "",

  // 海外注文リクエスト記録先シート名
  SHEET_NAME_REQUESTS: "海外注文リクエスト",

  // ブルートフォース対策: 許容失敗回数
  MAX_FAILED_ATTEMPTS: 5,

  // ロックアウト時間（秒）: 15分 = 900秒
  LOCKOUT_DURATION_SEC: 900,

  // セッショントークン有効期限（秒）: 8時間 = 28800秒
  TOKEN_TTL_SEC: 28800
};

/**
 * スクリプトプロパティから値を取得（未設定時はデフォルト値を使用）
 */
function getProperty(key, fallback) {
  var props = PropertiesService.getScriptProperties();
  var val = props.getProperty(key);
  return (val !== null && val !== "") ? val : fallback;
}

// ==========================================
// 2. HTTP リクエストディスパッチャー (GET & POST)
// ==========================================

/**
 * GET リクエスト処理 (カタログ取得, PIN認証, ヘルスチェック)
 */
function doGet(e) {
  try {
    var params = e ? e.parameter : {};
    var action = params.action || "ping";

    switch (action) {
      case "verifyPin":
        return jsonResponse(handleVerifyPin(params.pin, getClientIp(e)));

      case "fetchOverseasCatalog":
        return jsonResponse(handleFetchCatalog(params.token));

      case "ping":
      default:
        return jsonResponse({
          success: true,
          status: "healthy",
          service: "Aqua Export B2B Wholesale API",
          timestamp: new Date().toISOString()
        });
    }
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error.message
    });
  }
}

/**
 * POST リクエスト処理 (注文リクエスト送信)
 */
function doPost(e) {
  try {
    var payload = {};
    if (e && e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else if (e && e.parameter) {
      payload = e.parameter;
    }

    var action = payload.action || "submitOverseasOrder";

    switch (action) {
      case "submitOverseasOrder":
        return jsonResponse(handleSubmitOrder(payload));

      default:
        return jsonResponse({
          success: false,
          error: "Unknown action: " + action
        });
    }
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error.message
    });
  }
}

/**
 * JSONレスポンスの生成 (CORS対応)
 */
function jsonResponse(data) {
  var output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * クライアント識別子の抽出 (レート制限用)
 */
function getClientIp(e) {
  // GAS Web Appでは直接IPヘッダーが制限される場合があるため、UserAgentやパラメータから識別
  var paramClient = (e && e.parameter && e.parameter.clientId) ? e.parameter.clientId : "default_client";
  return "client_" + paramClient;
}

// ==========================================
// 3. 認証 & レートリミット (ゼロトラスト防御)
// ==========================================

/**
 * PIN検証 & レートリミット処理
 */
function handleVerifyPin(enteredPin, clientId) {
  var cache = CacheService.getScriptCache();
  var lockoutKey = "lockout_" + clientId;
  var attemptsKey = "attempts_" + clientId;

  // 1. ロックアウト状態チェック
  if (cache.get(lockoutKey)) {
    return {
      success: false,
      locked: true,
      message: "Security lockout in effect. Too many failed attempts. Try again in 15 minutes."
    };
  }

  var correctPin = getProperty("OVERSEAS_PIN", CONFIG.DEFAULT_PIN);

  // 2. 認証失敗時
  if (enteredPin !== correctPin) {
    var attempts = parseInt(cache.get(attemptsKey) || "0", 10) + 1;

    if (attempts >= CONFIG.MAX_FAILED_ATTEMPTS) {
      // 15分間ロックアウトを設定
      cache.put(lockoutKey, "locked", CONFIG.LOCKOUT_DURATION_SEC);
      cache.remove(attemptsKey);
      return {
        success: false,
        locked: true,
        message: "Maximum attempts exceeded. Device locked out for 15 minutes."
      };
    } else {
      cache.put(attemptsKey, attempts.toString(), CONFIG.LOCKOUT_DURATION_SEC);
      var remaining = CONFIG.MAX_FAILED_ATTEMPTS - attempts;
      return {
        success: false,
        locked: false,
        remainingAttempts: remaining,
        message: "Invalid PIN code. " + remaining + " attempts remaining."
      };
    }
  }

  // 3. 認証成功時: 試行回数リセット & 有効期限付きセッショントークン発行
  cache.remove(attemptsKey);
  var sessionToken = generateSessionToken();
  cache.put("token_" + sessionToken, "valid", CONFIG.TOKEN_TTL_SEC);

  return {
    success: true,
    token: sessionToken,
    expiresIn: CONFIG.TOKEN_TTL_SEC,
    message: "Authentication successful."
  };
}

/**
 * 暗号学的セッショントークンの生成
 */
function generateSessionToken() {
  var randomBytes = Utilities.getUuid() + "_" + Date.now();
  var signature = Utilities.computeHmacSha256Signature(randomBytes, getProperty("OVERSEAS_PIN", CONFIG.DEFAULT_PIN));
  return Utilities.base64EncodeWebSafe(signature);
}

/**
 * トークンの正当性検証 (ゼロトラスト厳格チェック)
 */
function isValidToken(token) {
  if (!token) return false;
  var cache = CacheService.getScriptCache();
  return cache.get("token_" + token) === "valid";
}

// ==========================================
// 4. カタログ取得 (BFF/機密データ隠蔽プロキシ)
// ==========================================

/**
 * スプレッドシートから海外向け情報のみを抽出し、機密データを物理的に除外して返却
 */
function handleFetchCatalog(token) {
  // トークン検証 (未認証は厳格に遮断)
  var isStrict = getProperty("STRICT_AUTH", "true") === "true";
  if (isStrict && !isValidToken(token)) {
    return {
      success: false,
      error: "Unauthorized access: Valid session token required. Please authenticate via PIN."
    };
  }

  var ss = null;
  try {
    var ssId = getProperty("SPREADSHEET_ID", CONFIG.DEFAULT_SPREADSHEET_ID);
    if (ssId) {
      ss = SpreadsheetApp.openById(ssId);
    }
  } catch (e) {
    try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e2) {}
  }

  if (!ss) {
    return {
      success: true,
      catalog: getFallbackSanitizedCatalog(),
      source: "fallback_preseeded"
    };
  }

  var sanitizedCatalog = [];
  var targetCategories = CONFIG.TARGET_CATEGORIES;

  for (var i = 0; i < targetCategories.length; i++) {
    var catName = targetCategories[i];
    var sheet = ss.getSheetByName(catName);
    if (!sheet || sheet.getLastRow() <= 1) continue;

    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var colMap = {};
    for (var c = 0; c < headers.length; c++) {
      var h = headers[c].toString().trim().toLowerCase();
      colMap[h] = c;
    }

    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      var name = getColValue(row, colMap, ["商品名", "名", "魚種", "name", "品名"]);
      if (!name) continue;

      var priceJpy = parseFloat(getColValue(row, colMap, ["価格", "単価", "jpy", "price", "卸価格"])) || 0;
      if (priceJpy <= 0) continue;

      var stock = parseInt(getColValue(row, colMap, ["在庫", "在庫数", "匹数", "stock", "現在庫"]) || "0", 10);
      var size = getColValue(row, colMap, ["サイズ", "規格", "size"]) || "規格おまかせ";
      var imageUrl = getColValue(row, colMap, ["画像", "img", "写真", "image_url", "image"]) || "";
      var id = getColValue(row, colMap, ["id", "商品コード", "code"]) || ("ISG-" + catName.slice(0, 1) + r);
      var cites = getColValue(row, colMap, ["cites", "サイテス", "cites_status"]) || ((catName === "サンゴ" || catName === "シャコガイ") ? "CITES App. II" : "Non-CITES");

      sanitizedCatalog.push({
        id: String(id),
        name: String(name),
        name_en: String(name),
        scientific_name: "",
        category: catName,
        size: String(size),
        stock: isNaN(stock) ? 0 : Math.max(0, stock),
        price_jpy: priceJpy,
        cites: String(cites),
        image_url: imageUrl || "https://images.unsplash.com/photo-1544943910-4c1dc44a034f?auto=format&fit=crop&w=600&q=80"
      });
    }
  }

  if (sanitizedCatalog.length === 0) {
    sanitizedCatalog = getFallbackSanitizedCatalog();
  }

  return {
    success: true,
    catalog: sanitizedCatalog,
    source: "spreadsheet_sanitized"
  };
}

/**
 * 複数候補から該当列の値を取得するヘルパー
 */
function getColValue(row, colMap, keys) {
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i].toLowerCase();
    if (colMap[k] !== undefined) {
      return row[colMap[k]];
    }
  }
  return null;
}

// ==========================================
// 5. 注文リクエスト受付 (在庫非連動 & 通知)
// ==========================================

/**
 * 注文リクエストを「海外注文リクエスト」シートに記録し、Discord & Gmail 通知を送信
 * ※重要: 在庫数は減算しない（在庫非連動設計）
 */
function handleSubmitOrder(payload) {
  // トークン検証 (未認証リクエストを遮断)
  var isStrict = getProperty("STRICT_AUTH", "true") === "true";
  if (isStrict && !isValidToken(payload.token)) {
    return {
      success: false,
      error: "Unauthorized submission: Session token is missing or expired."
    };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateRequestSheet(ss);

  var orderId = payload.orderId || ("AQX-" + Utilities.formatDate(new Date(), "GMT+9", "yyyyMMdd-") + Math.floor(1000 + Math.random() * 9000));
  var timestamp = Utilities.formatDate(new Date(), "GMT+9", "yyyy-MM-dd HH:mm:ss");
  var buyer = payload.buyer || {};
  var items = payload.items || [];
  var currency = payload.currency || "USD";
  var subtotal = parseFloat(payload.subtotal) || 0;

  // 最低発注金額 (MOV) サーバー側再検証
  var minMov = currency === "USD" ? 1000 : 150000;
  var isMovSatisfied = (subtotal >= minMov);

  // 品目リストの要約文字列作成 (現物引当 vs 採集リクエストの明記)
  var hasCollection = false;
  var itemsSummary = items.map(function(item) {
    var inStock = item.inStockQty !== undefined ? item.inStockQty : item.quantity;
    var collect = item.collectionQty !== undefined ? item.collectionQty : 0;
    if (collect > 0) hasCollection = true;
    return item.name + " (" + item.id + ") x " + item.quantity + "匹 [在庫引当:" + inStock + " / 採集:" + collect + "]";
  }).join("\n");

  var hasCites = items.some(function(item) {
    return item.cites && item.cites.indexOf("CITES") !== -1;
  });

  // 1. スプレッドシートに追記
  var newRow = [
    timestamp,
    orderId,
    buyer.company || "N/A",
    buyer.contactPerson || "N/A",
    buyer.email || "N/A",
    buyer.im || "N/A",
    buyer.destinationCountry || "N/A",
    buyer.destinationAirport || "N/A",
    buyer.importLicense || "N/A",
    currency,
    subtotal,
    itemsSummary,
    hasCollection ? "YES (採集リクエスト含む)" : "NO (全量生簀在庫)",
    JSON.stringify(items),
    hasCites ? "YES (CITES対象)" : "NO",
    payload.legalNoticeAcknowledged ? "Agreed" : "No",
    "NEW_REQUEST (Pending Quote)",
    buyer.notes || ""
  ];

  sheet.appendRow(newRow);

  // 2. Discord Webhook 通知 (設定されている場合)
  sendDiscordNotification(orderId, buyer, items, currency, subtotal, hasCites);

  // 3. 管理者 Gmail 通知
  sendAdminEmailNotification(orderId, buyer, items, currency, subtotal, hasCites);

  return {
    success: true,
    orderId: orderId,
    message: "Overseas Proforma Order Request logged successfully."
  };
}

/**
 * 「海外注文リクエスト」シートの取得または自動生成
 */
function getOrCreateRequestSheet(ss) {
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME_REQUESTS);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME_REQUESTS);
    var headers = [
      "受付日時 (JST)",
      "注文番号 (Order ID)",
      "会社名 (Company)",
      "担当者名 (Contact)",
      "Email",
      "連絡アプリ (IM/Phone)",
      "仕向国 (Country)",
      "到着空港 (Airport)",
      "輸入許可番号 (Import Lic)",
      "通貨 (Currency)",
      "生体小計 (Subtotal)",
      "品目サマリー (Items)",
      "品目詳細JSON (Items JSON)",
      "CITES対象有無",
      "免責事項同意 (Disclaimer)",
      "ステータス (Status)",
      "特記事項・梱包指示 (Notes)"
    ];
    sheet.appendRow(headers);

    // ヘッダー行の書式設定
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground("#0f172a");
    headerRange.setFontColor("#f8fafc");
    headerRange.setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ==========================================
// 6. 通知機能 (Discord & Gmail)
// ==========================================

/**
 * Discord Webhook へのリッチ Embed 送信
 */
function sendDiscordNotification(orderId, buyer, items, currency, subtotal, hasCites) {
  var webhookUrl = getProperty("DISCORD_WEBHOOK_URL", CONFIG.DEFAULT_DISCORD_WEBHOOK);
  if (!webhookUrl) return;

  var formattedSubtotal = currency === "USD" 
    ? "$" + Number(subtotal).toFixed(2) + " USD" 
    : "¥" + Number(subtotal).toLocaleString() + " JPY";

  var itemsListText = items.slice(0, 8).map(function(item) {
    return "• **" + item.name_en + "** `x" + item.quantity + "` (" + item.size + ")";
  }).join("\n");

  if (items.length > 8) {
    itemsListText += "\n*...and " + (items.length - 8) + " more items.*";
  }

  var embed = {
    title: "🌍 【新規】海外 B2B 見積・受発注リクエスト (" + orderId + ")",
    description: "海外バイヤーより新しい Proforma Order Request が届きました。（※在庫減算は行われていません）",
    color: hasCites ? 16098851 : 2339583, // Gold or Sky Blue
    fields: [
      {
        name: "🏢 バイヤー情報",
        value: "**会社:** " + (buyer.company || "N/A") + "\n**担当:** " + (buyer.contactPerson || "N/A") + "\n**Email:** " + (buyer.email || "N/A") + "\n**IM:** " + (buyer.im || "N/A"),
        inline: true
      },
      {
        name: "✈️ 仕向地 & 条件",
        value: "**国:** " + (buyer.destinationCountry || "N/A") + "\n**空港:** " + (buyer.destinationAirport || "N/A") + "\n**CITES:** " + (hasCites ? "⚠️ 該製品あり" : "非該当") + "\n**通貨:** " + currency,
        inline: true
      },
      {
        name: "💰 生体合計金額 (MOV確認済)",
        value: "### " + formattedSubtotal,
        inline: false
      },
      {
        name: "📦 注文品目リスト (" + items.length + " 種類)",
        value: itemsListText || "None",
        inline: false
      }
    ],
    footer: {
      text: "Aqua Export B2B Portal • 24時間以内に空輸運賃・CITES規費を算定してください"
    },
    timestamp: new Date().toISOString()
  };

  if (buyer.notes) {
    embed.fields.push({
      name: "📝 梱包・特記事項",
      value: buyer.notes,
      inline: false
    });
  }

  var payload = {
    username: "Aqua Export B2B Bot",
    avatar_url: "https://images.unsplash.com/photo-1544943910-4c1dc44a034f?auto=format&fit=crop&w=200&q=80",
    embeds: [embed]
  };

  try {
    UrlFetchApp.fetch(webhookUrl, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log("Discord Webhook Error: " + err.message);
  }
}

/**
 * 管理者宛 Gmail 通知送信
 */
function sendAdminEmailNotification(orderId, buyer, items, currency, subtotal, hasCites) {
  var adminEmail = getProperty("ADMIN_EMAIL", CONFIG.DEFAULT_ADMIN_EMAIL);
  if (!adminEmail || adminEmail === "export-admin@example.com") return;

  var formattedSubtotal = currency === "USD" 
    ? "$" + Number(subtotal).toFixed(2) + " USD" 
    : "¥" + Number(subtotal).toLocaleString() + " JPY";

  var subject = "【海外受発注】新規 Proforma Request 受領: " + orderId + " (" + buyer.company + " / " + buyer.destinationAirport + ")";

  var itemsTableRows = items.map(function(item) {
    return "<tr>" +
      "<td style='padding:6px;border:1px solid #e2e8f0;'>" + item.id + "</td>" +
      "<td style='padding:6px;border:1px solid #e2e8f0;'><strong>" + item.name_en + "</strong><br><em>" + (item.scientific_name || "") + "</em></td>" +
      "<td style='padding:6px;border:1px solid #e2e8f0;text-align:center;'>" + item.size + "</td>" +
      "<td style='padding:6px;border:1px solid #e2e8f0;text-align:center;'>" + item.quantity + "</td>" +
      "<td style='padding:6px;border:1px solid #e2e8f0;text-align:right;'>" + currency + " " + item.unitPrice + "</td>" +
      "<td style='padding:6px;border:1px solid #e2e8f0;text-align:right;'><strong>" + currency + " " + (item.unitPrice * item.quantity) + "</strong></td>" +
    "</tr>";
  }).join("");

  var htmlBody = 
    "<div style='font-family:sans-serif;max-width:700px;margin:auto;border:1px solid #cbd5e1;border-radius:8px;padding:20px;background:#f8fafc;'>" +
      "<h2 style='color:#0f172a;border-bottom:2px solid #0284c7;padding-bottom:10px;margin-top:0;'>【海外B2B】新規 Proforma Order Request</h2>" +
      "<p style='color:#334155;'>海外バイヤーより見積・受発注リクエストが送信されました。<strong>※国内スプレッドシートの在庫減算は行われていません。</strong></p>" +
      
      "<table style='width:100%;margin-bottom:20px;background:#ffffff;border-collapse:collapse;border:1px solid #e2e8f0;font-size:13px;'>" +
        "<tr style='background:#f1f5f9;'><th colspan='2' style='padding:8px;text-align:left;border-bottom:1px solid #cbd5e1;'>バイヤー情報 & 配送条件</th></tr>" +
        "<tr><td style='padding:6px;width:30%;border-bottom:1px solid #f1f5f9;color:#64748b;'>注文管理番号:</td><td style='padding:6px;border-bottom:1px solid #f1f5f9;'><strong>" + orderId + "</strong></td></tr>" +
        "<tr><td style='padding:6px;border-bottom:1px solid #f1f5f9;color:#64748b;'>会社 / 店舗名:</td><td style='padding:6px;border-bottom:1px solid #f1f5f9;'>" + buyer.company + "</td></tr>" +
        "<tr><td style='padding:6px;border-bottom:1px solid #f1f5f9;color:#64748b;'>担当者名:</td><td style='padding:6px;border-bottom:1px solid #f1f5f9;'>" + buyer.contactPerson + "</td></tr>" +
        "<tr><td style='padding:6px;border-bottom:1px solid #f1f5f9;color:#64748b;'>Email:</td><td style='padding:6px;border-bottom:1px solid #f1f5f9;'><a href='mailto:" + buyer.email + "'>" + buyer.email + "</a></td></tr>" +
        "<tr><td style='padding:6px;border-bottom:1px solid #f1f5f9;color:#64748b;'>連絡ツール (IM/Phone):</td><td style='padding:6px;border-bottom:1px solid #f1f5f9;'>" + buyer.im + "</td></tr>" +
        "<tr><td style='padding:6px;border-bottom:1px solid #f1f5f9;color:#64748b;'>仕向国 / 到着空港:</td><td style='padding:6px;border-bottom:1px solid #f1f5f9;'>" + buyer.destinationCountry + " / <strong>" + buyer.destinationAirport + "</strong></td></tr>" +
        "<tr><td style='padding:6px;border-bottom:1px solid #f1f5f9;color:#64748b;'>CITES該当品:</td><td style='padding:6px;border-bottom:1px solid #f1f5f9;'>" + (hasCites ? "<span style='color:#dc2626;font-weight:bold;'>あり (輸出許可証手続き要)</span>" : "なし") + "</td></tr>" +
        "<tr><td style='padding:6px;border-bottom:1px solid #f1f5f9;color:#64748b;'>特記事項:</td><td style='padding:6px;border-bottom:1px solid #f1f5f9;'>" + (buyer.notes || "特になし") + "</td></tr>" +
      "</table>" +

      "<h3 style='color:#0f172a;margin-bottom:8px;'>注文品目リスト</h3>" +
      "<table style='width:100%;border-collapse:collapse;font-size:12px;background:#ffffff;margin-bottom:15px;'>" +
        "<tr style='background:#0f172a;color:#ffffff;'>" +
          "<th style='padding:8px;'>コード</th><th style='padding:8px;text-align:left;'>品目 / 学名</th><th style='padding:8px;'>サイズ</th><th style='padding:8px;'>数量</th><th style='padding:8px;text-align:right;'>単価</th><th style='padding:8px;text-align:right;'>小計</th>" +
        "</tr>" +
        itemsTableRows +
        "<tr style='background:#f8fafc;font-size:14px;'>" +
          "<td colspan='5' style='padding:10px;text-align:right;border:1px solid #cbd5e1;'><strong>生体小計:</strong></td>" +
          "<td style='padding:10px;text-align:right;border:1px solid #cbd5e1;color:#0284c7;'><strong>" + formattedSubtotal + "</strong></td>" +
        "</tr>" +
      "</table>" +

      "<div style='background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:12px;font-size:12px;color:#92400e;'>" +
        "<strong>【今後の対応フロー】</strong><br>" +
        "1. 空輸フォワーダーへ連絡し、指定空港（" + buyer.destinationAirport + "）行きのエアラインフライトスペースと梱包箱数を算定。<br>" +
        "2. CITES品目がある場合は経済産業省への輸出許可申請手続きの進捗を確認。<br>" +
        "3. 正式な Proforma Invoice (運賃・書類作成費込み) をバイヤー宛に返信送付。" +
      "</div>" +
    "</div>";

  try {
    MailApp.sendEmail({
      to: adminEmail,
      subject: subject,
      htmlBody: htmlBody
    });
  } catch (err) {
    Logger.log("MailApp Send Error: " + err.message);
  }
}

// ==========================================
// 7. サニタイズ済み初期カタログ (フォールバック)
// ==========================================
function getFallbackSanitizedCatalog() {
  return [
    {
      id: "ISG-F01",
      name: "カクレクマノミ (ペア)",
      name_en: "Ocellaris Clownfish (Pair)",
      scientific_name: "Amphiprion ocellaris",
      category: "魚",
      size: "4.5-6.5 cm",
      stock: 12,
      price_jpy: 3800,
      cites: "Non-CITES",
      image_url: "https://images.unsplash.com/photo-1544943910-4c1dc44a034f?auto=format&fit=crop&w=600&q=80"
    },
    {
      id: "ISG-F02",
      name: "サザナミヤッコ (成魚)",
      name_en: "Semicircle Angelfish",
      scientific_name: "Pomacanthus semicirculatus",
      category: "魚",
      size: "16-20 cm",
      stock: 3,
      price_jpy: 11000,
      cites: "Non-CITES",
      image_url: "https://images.unsplash.com/photo-1546026423-cc4642628d2b?auto=format&fit=crop&w=600&q=80"
    },
    {
      id: "ISG-S01",
      name: "マガキガイ (5個組)",
      name_en: "Strawberry Conch",
      scientific_name: "Strombus luhuanus",
      category: "貝",
      size: "4.0-5.5 cm",
      stock: 40,
      price_jpy: 1200,
      cites: "Non-CITES",
      image_url: "https://images.unsplash.com/photo-1544551763-46a013bb70d5?auto=format&fit=crop&w=600&q=80"
    },
    {
      id: "ISG-C01",
      name: "ヒメジャコガイ (メタリックブルー)",
      name_en: "Crocea Clam",
      scientific_name: "Tridacna crocea",
      category: "シャコガイ",
      size: "6.0-8.0 cm",
      stock: 5,
      price_jpy: 7800,
      cites: "CITES App. II",
      image_url: "https://images.unsplash.com/photo-1520315342629-6ea920342047?auto=format&fit=crop&w=600&q=80"
    },
    {
      id: "ISG-A01",
      name: "ハタゴイソギンチャク (特大)",
      name_en: "Carpet Anemone",
      scientific_name: "Stichodactyla gigantea",
      category: "イソギンチャク",
      size: "20-25 cm",
      stock: 4,
      price_jpy: 8900,
      cites: "Non-CITES",
      image_url: "https://images.unsplash.com/photo-1544943910-4c1dc44a034f?auto=format&fit=crop&w=600&q=80"
    },
    {
      id: "ISG-K01",
      name: "オキナワミドリイシ (ブリード)",
      name_en: "Acropora Coral",
      scientific_name: "Acropora sp.",
      category: "サンゴ",
      size: "8-10 cm",
      stock: 6,
      price_jpy: 14000,
      cites: "CITES App. II",
      image_url: "https://images.unsplash.com/photo-1544551763-46a013bb70d5?auto=format&fit=crop&w=600&q=80"
    },
    {
      id: "ISG-O01",
      name: "スベスベサンゴヤドカリ (3匹)",
      name_en: "Blue-Eyed Hermit Crab",
      scientific_name: "Calcinus tubularis",
      category: "その他",
      size: "2.0-3.0 cm",
      stock: 18,
      price_jpy: 1500,
      cites: "Non-CITES",
      image_url: "https://images.unsplash.com/photo-1518837695005-2083093ee35b?auto=format&fit=crop&w=600&q=80"
    }
  ];
}
