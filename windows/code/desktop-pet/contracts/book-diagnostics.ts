export interface DiagnosticCheck {id:string;status:'PASS'|'FAIL'|'BLOCKED'|'NOT_RUN';detail:string;repair:string}
export interface BookDiagnosticReport {schemaVersion:'allmind-diagnostics/v1';at:string;checks:DiagnosticCheck[];privacy:string;modelSubmissions:0}
