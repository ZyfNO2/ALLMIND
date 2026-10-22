/** Local settings only; installation paths and QR login material are never exported with a character. */
export interface NapcatHostSettings {revision:number;installDirectory:string;webuiPort:number;credentialId:string}
export interface NapcatHostView {
  revision:number;installDirectory:string;webuiPort:number;configured:boolean;
  reachable:boolean;online:boolean;accountId:string|null;nickname:string;accountMatches:boolean;
  phase:string;error:string|null;
}
