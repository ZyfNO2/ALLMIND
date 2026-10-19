/** A result is reported only by an explicit outcome, never by a clock or an ended flag. */
export function reportedResultStatus(quote:string):'unknown'|'user_reported'{
  if(/不知道|未知|还没(?:有)?出来|尚未|还未|暂未|是否|不确定|可能|[?？]/.test(quote))return 'unknown';
  return /通过了|没(?:有)?通过|未通过|成功了|失败了/.test(quote)?'user_reported':'unknown';
}
