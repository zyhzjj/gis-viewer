/*
 * 站点公开配置。
 *
 * 高德 Web JS API Key 会随网页请求发送给浏览器，本身可以放在这里；请同时在
 * 高德控制台限制允许使用的域名。securityJsCode 属于服务端秘密，严禁写入此文件。
 */
window.GIS_VIEWER_CONFIG = {
  amap: {
    // 申请高德“Web端（JS API）”Key 后填写，例如："abc123..."
    key: "",

    // 安全代理的公开入口，必须以 /_AMapService 结尾。
    // 例如："https://maps.example.com/_AMapService"
    serviceHost: ""
  }
};
