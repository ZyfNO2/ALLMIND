/** Lossless Unicode chunks. This enables bounded synthesis/preload while earlier chunks play. */
export function speechChunks(text:string,maximum=500):string[]{
 if(typeof text!=='string'||!text.trim()||text.includes('\0')||!Number.isInteger(maximum)||maximum<20||maximum>2000)throw Error('朗读正文或分段上限无效。');
 const chars=Array.from(text);if(chars.length>20000)throw Error('连续朗读最多20000字；请选择明确段落，没有截断。');
 const rows:string[]=[];let position=0;
 while(position<chars.length){let end=Math.min(position+maximum,chars.length);if(end<chars.length){for(let i=end-1;i>=position+Math.floor(maximum/2);i--)if(/[。！？.!?\n]/u.test(chars[i]!)){end=i+1;break;}}
  const row=chars.slice(position,end).join('');if(row.trim())rows.push(row);else if(rows.length)rows[rows.length-1]+=row;else throw Error('朗读前导空白超过分段上限，请明确选择正文。');position=end;
 }return rows;
}
