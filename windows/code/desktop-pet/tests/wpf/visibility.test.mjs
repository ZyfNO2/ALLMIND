import test from 'node:test';
import assert from 'node:assert/strict';
import {validateVisibility} from '../../desktop/wpf/pipe.mjs';
const visible=()=>({revision:1,state:'VISIBLE',mode:'smart',visible:true,manualHidden:false,topmost:true,notificationAllowed:true,reasons:[]});
test('visibility acknowledgement is explicit, scoped and strips arbitrary diagnostics',()=>{
 const value={...visible(),token:'synthetic-secret',detectorError:'no public diagnostics',musicRequested:true};
 assert.deepEqual(validateVisibility(value),visible());
 assert.deepEqual(validateVisibility({...visible(),state:'HIDDEN',visible:false,manualHidden:true,notificationAllowed:false,reasons:['manual','fullscreen']}),{...visible(),state:'HIDDEN',visible:false,manualHidden:true,notificationAllowed:false,reasons:['manual','fullscreen']});
});
test('visibility rejects inconsistent, oversized, malformed and unknown states',()=>{
 for(const delta of [{revision:0},{revision:NaN},{revision:1.5},{state:'ready'},{mode:'execute'},{reasons:['arbitrary']},{reasons:Array(11).fill('manual')},{visible:'true'},{manualHidden:1},{state:'SUSPENDED'},{visible:false},{notificationAllowed:'yes'}])assert.throws(()=>validateVisibility({...visible(),...delta}));
});
