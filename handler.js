'use strict';
require('twilio');
//import * as twilio from 'twilio';
const moment = require("moment");

const pathURL = 'https://eb6imaxhqa.execute-api.us-east-1.amazonaws.com/dev';
const numberCallFrom = "+19382009794";

const recalculateCallAfterTime = () => {
  // Here you can set whatever time you want.
  return moment().add(2, "minutes").format("HHmm");
}

const finishDialerTask = async (client, workspaceSid, taskSid) => {
  return await client.taskrouter.workspaces(workspaceSid)
  .tasks(taskSid)
  .update({
    assignmentStatus: 'completed',
  });
}

const updateCurrentNumberIdx = async (client, workspaceSid, task, newValue) => {
  const { sid, attributes } = task;
  const parsedAttributes = JSON.parse(attributes);
  const newAttributes = {...parsedAttributes, currentNumberIdx: newValue};

  return await client.taskrouter.workspaces(workspaceSid)
  .tasks(sid)
  .update({
    attributes: JSON.stringify(newAttributes)
  });
}


const makeCall = async (client, task, currentNumberIdx) => {
  const { sid, attributes } = task;
  const { queue, numbers } = JSON.parse(attributes);
  const call = await client.calls.create({
    url: `${pathURL}/evaluate-call?taskSid=${sid}&queue=${queue}`,
    statusCallback: `${pathURL}/evaluate-complete-call?taskSid=${sid}`,
    to: numbers[currentNumberIdx],
    from: numberCallFrom,
    machineDetection: 'Enable'
  });
}

module.exports.createCall = async (event, context, callback) => {
  // console.log('INIT automatedContactCenterAssignmentCallback')
  const client = context.getTwilioClient();
  const taskSid = event.TaskSid;
  // Extract the Task's attributes
  const attributes = event.TaskAttributes;
  const { numbers, currentNumberIdx, queue } = JSON.parse(attributes);
  // Extract the Worker's attributes
  const workerAttributes = event.WorkerAttributes;
  const { bot } = JSON.parse(workerAttributes);
  //Check if the Task is assigned to an automated Worker
  if(bot) {
    //Make the call using the Task's attributes and machine detection feature (Twilio AMD)
    const call = await client.calls.create({
      url: `${pathURL}/evaluate-call?taskSid=${taskSid}&queue=${queue}`,
      statusCallback: `${pathURL}/evaluate-complete-call?taskSid=${taskSid}`,
      to: numbers[currentNumberIdx],
      from: numberCallFrom,
      machineDetection: 'Enable'
    });
    //Callback instructing worker to accept the task
    callback(null, { 'instruction' : 'accept' });
  } else {
    callback(null);
  }
};


module.exports.evaluateCall = async (context, event, callback) => {
  const client = context.getTwilioClient();
  const twiml = new Twilio.twiml.VoiceResponse();
  let reason;
  if(event.AnsweredBy === "human") {
    // Transfer call to Flex. This will create another Task with some default attributes and the ones passed to the enqueue function.
    twiml.enqueue({
        workflowSid: context.WORKFLOW_SID,
      }).task({}, JSON.stringify({
        dialer: false,
        queue: event.queue
      }));
    reason = "Call sent to Queue";
    //Set automated worker task as completed
    await client.taskrouter.workspaces(context.WORKSPACE_SID).tasks(event.taskSid).update({
        assignmentStatus: 'completed',
        reason
      });
  } else {
    twiml.hangup();
    reason = "Call failed";
  }
  callback(null, twiml);
}

module.exports.evaluateCompleteCall = async (context, event, callback) => {
  const client = context.getTwilioClient();
  if(event.AnsweredBy !== "human") {
    const task = await client.taskrouter.workspaces(context.WORKSPACE_SID).tasks(event.taskSid).fetch();
    
    const attributes = JSON.parse(task.attributes);
    if(attributes.retries > (attributes.attempts + 1)) {
      if(attributes.numbers.length > (attributes.currentNumberIdx +1)) {
        await updateCurrentNumberIdx(client, context.WORKSPACE_SID, task, attributes.currentNumberIdx + 1);
        await makeCall(client, task, attributes.currentNumberIdx +1);
      } else {
        await finishDialerTask(client, context.WORKSPACE_SID,event.taskSid)
        
        await client.taskrouter.workspaces(context.WORKSPACE_SID).tasks.create({ attributes: JSON.stringify({
          ...attributes,
          attempts: attributes.attempts + 1,
          callAfterTime: parseInt(recalculateCallAfterTime()),
          currentNumberIdx: 0
        }), workflowSid: process.env.WORKFLOW_SID });
      }
    } else {
      await finishDialerTask(client, context.WORKSPACE_SID, event.taskSid);
    }
  }
  callback();
};

const changeOutboundCallTaskToBeAcceptedByFlex = async (client, context, event,
  attributes) => {
  return await client.taskrouter.workspaces(context.WORKSPACE_SID).tasks(event.TaskSid).update({
    attributes: JSON.stringify({ ...attributes, to: numberCallFrom, name: attributes.to })
  });
}

module.exports.assignCallFlex = async (context, event, callback) => {
  const client = context.getTwilioClient();
  const attributes = event.TaskAttributes && JSON.parse(event.TaskAttributes);
  //outbound call redirected to Flex
  if(event.EventType === "task.created" && attributes.dialer == false) {
    await changeOutboundCallTaskToBeAcceptedByFlex(client, context, event, attributes);
  }
  callback();
};

module.exports.demoServerLess = (event, context, callback) => {
  
  const response = {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*', // Required for CORS support to work
    },
    body: JSON.stringify({
      message: 'Go Serverless v1.0! Your function executed successfully!',
      input: event,
    }),
  };

  callback(null, response);
};
