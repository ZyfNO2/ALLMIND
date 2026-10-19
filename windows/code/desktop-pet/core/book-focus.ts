import type { BookScope } from '../contracts/memory-book.js';
import type { CompanionRepository } from '../contracts/book-companion.js';

/** Deadline lives in Book; clients only display the remaining time. */
export function focusState(repository:CompanionRepository,scope:BookScope,now=Date.now()){
  const data=repository.loadCompanionData(scope),timer=data.focusTimer;
  if(data.focus&&timer&&timer.completedAt===undefined&&now>=timer.until){
    data.focus=false;timer.completedAt=now;return repository.saveCompanionData(scope,data);
  }
  return data;
}
