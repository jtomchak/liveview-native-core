(async()=>{
 const repository=globalThis.__lvnOffline;const commands=repository.getCommands();
 if(commands.length!==1||commands[0].state!=='queued')throw new Error('Durable queued action lost on restart');
 const pending=commands[0];if(repository.get('workshop:'+pending.command.taskId)?.submissionId!==pending.command.operationId)throw new Error('Draft association lost');
 globalThis.__lvnScrollTo?.(350);
 return {ok:true,processRestartRestoredAction:true,operationId:pending.command.operationId,taskId:pending.command.taskId,baselineVersion:pending.command.expectedVersion,draftRetained:true};
})()
