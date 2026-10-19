export interface WeeklyReviewResult {
  from:string;to:string;timezone:string;revision:number;generatedAt:string;
  days:{date:string;turns:number}[];chatDays:number;turns:number;newMemories:number;relatedPageLinks:number;
  topics:string[];omittedMemories:number;
  memories:{entryId:string;revision:number;sourceId:string;recordedAt:string;subject:string;predicate:string;value:string;quote:string}[];
}
/** Ephemeral model wording, never a new memory or account of unrecorded activity. */
export interface WeeklyNarrativeResult {
  review:WeeklyReviewResult;
  model:string|null;
  items:{text:string;entryIds:string[]}[];
}
