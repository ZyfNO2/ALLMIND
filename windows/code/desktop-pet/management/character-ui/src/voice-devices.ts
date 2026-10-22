export interface VoiceDevicePreference {input:string|null;output:string|null}
const key='allmind-local-voice-devices-v1'
export function readVoiceDevices():VoiceDevicePreference{
 const raw=localStorage.getItem(key);if(!raw)return {input:null,output:null}
 const value=JSON.parse(raw) as VoiceDevicePreference
 if(!value||Object.keys(value).some(name=>!['input','output'].includes(name))||[value.input,value.output].some(id=>id!==null&&(typeof id!=='string'||!id||id.length>512||id.includes('\0'))))throw Error('本机音频设备偏好无效；请在语音设置重新选择。')
 return value
}
export function saveVoiceDevices(value:VoiceDevicePreference){localStorage.setItem(key,JSON.stringify(value));window.dispatchEvent(new Event('allmind-voice-device-change'))}
