/** Dell iDRAC9 HTML5 实际是 `/vmc/vconsole`；部分资料/旧固件写成 `/vnc/vconsole`。两者都认。 */
export const DELL_VCONSOLE_WS_PATTERN = /\/v[mn]c\/vconsole/i;

export const DELL_VCONSOLE_HTTP_PATTERN =
  /\/restgui\/(?:html5viewer|vconsole(?:\/index\.html)?|views\/configuration\/vconsole)|\/sysmgmt\/[^/]+\/server\/vconsole/i;

export const HPE_IRCPORT_WS_PATTERN = /\/wss\/ircport/i;

export const KNOWN_KVM_WEBSOCKET_PATTERN =
  /\/kvm(?:\/|\?|$)|\/kvm\/video|\/v[mn]c\/vconsole|:5900\/(?:$|\?|vkvm\/?)|\/wss\/ircport|:(?:2198|2199|8208)\/(?:websocket)?(?:\?|$)/i;

export const EXPLICIT_KVM_LAUNCH_URL_PATTERN =
  /\/api\/kvm\/token|kvmservice|setkvmkey|starth5kvm|\/kvm\/video|\/v[mn]c\/vconsole|\/restgui\/(?:html5viewer|vconsole)|\/wss\/ircport|\/bmc\/pages\/remote\/kvm_by_html5\.html|\/bmc\/php\/gettoken\.php|\/sysmgmt\/[^/]+\/server\/vconsole/i;

export function isKnownKvmWebSocketUrl(url: string) {
  return KNOWN_KVM_WEBSOCKET_PATTERN.test(url);
}

export function isDellVconsoleUrl(url: string) {
  return DELL_VCONSOLE_WS_PATTERN.test(url) || DELL_VCONSOLE_HTTP_PATTERN.test(url);
}
