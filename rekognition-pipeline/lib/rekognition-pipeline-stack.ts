import * as cdk from 'aws-cdk-lib';
import events = require('aws-cdk-lib/aws-events');
import iam = require('aws-cdk-lib/aws-iam');
import { S3EventSource, SqsEventSource, SnsEventSource, DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import sns = require('aws-cdk-lib/aws-sns');
import snsSubscriptions = require("aws-cdk-lib/aws-sns-subscriptions");
import sqs = require('aws-cdk-lib/aws-sqs');
import dynamodb = require('aws-cdk-lib/aws-dynamodb');
import lambda = require('aws-cdk-lib/aws-lambda');
import s3 = require('aws-cdk-lib/aws-s3');
import {LambdaFunction} from "aws-cdk-lib/aws-events-targets";
import { Construct } from 'constructs';

export class RekognitionPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    
    //**********SNS Topics******************************
    const jobCompletionTopic = new sns.Topic(this, 'JobCompletion');

    //**********IAM Roles******************************
    const rekognitionServiceRole = new iam.Role(this, 'RekognitionServiceRole', {
      assumedBy: new iam.ServicePrincipal('rekognition.amazonaws.com')
    });
    rekognitionServiceRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [jobCompletionTopic.topicArn],
        actions: ["sns:Publish"]
      })
    );


    //**********S3 Batch Operations Role******************************
    const s3BatchOperationsRole = new iam.Role(this, 'S3BatchOperationsRole', {
      assumedBy: new iam.ServicePrincipal('batchoperations.s3.amazonaws.com')
    });

    //**********S3 Bucket******************************
    //S3 bucket for input items and output
    const contentBucket = new s3.Bucket(this, 'ContentBucket', {versioned: false});

    const existingContentBucket = new s3.Bucket(this, 'ExistingContentBucket', {versioned: false});
    existingContentBucket.grantReadWrite(s3BatchOperationsRole)

    const inventoryAndLogsBucket = new s3.Bucket(this, 'InventoryAndLogsBucket', {versioned: false});
    inventoryAndLogsBucket.grantReadWrite(s3BatchOperationsRole)

    const outputBucket = new s3.Bucket(this, 'OutputBucket', {versioned: false});

    //**********DynamoDB Table*************************
    //DynamoDB table with links to output in S3
    const itemsTable = new dynamodb.Table(this, 'ItemsTable', {
      partitionKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_IMAGE
    });

    //**********SQS Queues*****************************
    //DLQ
    const dlq = new sqs.Queue(this, 'DLQ', {
      visibilityTimeout: cdk.Duration.seconds(30), retentionPeriod: cdk.Duration.seconds(1209600)
    });

    //Input Queue for sync jobs
    const syncJobsQueue = new sqs.Queue(this, 'SyncJobs', {
      visibilityTimeout: cdk.Duration.seconds(30), retentionPeriod: cdk.Duration.seconds(1209600), deadLetterQueue : { queue: dlq, maxReceiveCount: 50}
    });

    //Input Queue for async jobs
    const asyncJobsQueue = new sqs.Queue(this, 'AsyncJobs', {
      visibilityTimeout: cdk.Duration.seconds(30), retentionPeriod: cdk.Duration.seconds(1209600), deadLetterQueue : { queue: dlq, maxReceiveCount: 50}
    });

    //Queue
    const jobResultsQueue = new sqs.Queue(this, 'JobResults', {
      visibilityTimeout: cdk.Duration.seconds(900), retentionPeriod: cdk.Duration.seconds(1209600), deadLetterQueue : { queue: dlq, maxReceiveCount: 50}
    });
    //Trigger
    jobCompletionTopic.addSubscription(
      new snsSubscriptions.SqsSubscription(jobResultsQueue)
    );

    //**********Lambda Functions******************************

    // Helper Layer with helper functions
    const helperLayer = new lambda.LayerVersion(this, 'HelperLayer', {
      code: lambda.Code.fromAsset('lambda/helper'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_9],
      license: 'Apache-2.0',
      description: 'Helper layer.',
    });

    //------------------------------------------------------------

    // S3 Event processor
    const s3Processor = new lambda.Function(this, 'S3Processor', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/s3processor'),
      handler: 'lambda_function.lambda_handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        SYNC_QUEUE_URL: syncJobsQueue.queueUrl,
        ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl,
        ITEMS_TABLE: itemsTable.tableName,
        OUTPUT_BUCKET: outputBucket.bucketName
      }
    });
    //Layer
    s3Processor.addLayers(helperLayer)
    //Trigger
    s3Processor.addEventSource(new S3EventSource(contentBucket, {
      events: [ s3.EventType.OBJECT_CREATED ],  
      filters: [ { suffix: '.mov' }]  
    }));  
    s3Processor.addEventSource(new S3EventSource(contentBucket, { 
      events: [ s3.EventType.OBJECT_CREATED ],  
      filters: [ { suffix: '.mp4' }]  
    }));
    s3Processor.addEventSource(new S3EventSource(contentBucket, { 
      events: [ s3.EventType.OBJECT_CREATED ],  
      filters: [ { suffix: '.png' }]  
    }));  
    s3Processor.addEventSource(new S3EventSource(contentBucket, { 
      events: [ s3.EventType.OBJECT_CREATED ],  
      filters: [ { suffix: '.jpg' }]  
    }));  
    s3Processor.addEventSource(new S3EventSource(contentBucket, { 
      events: [ s3.EventType.OBJECT_CREATED ],  
      filters: [ { suffix: '.jpeg' }]
    }));
    //Permissions
    itemsTable.grantReadWriteData(s3Processor)
    syncJobsQueue.grantSendMessages(s3Processor)
    asyncJobsQueue.grantSendMessages(s3Processor)

    //------------------------------------------------------------

    // S3 Batch Operations Event processor 
    const s3BatchProcessor = new lambda.Function(this, 'S3BatchProcessor', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/s3batchprocessor'),
      handler: 'lambda_function.lambda_handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        ITEMS_TABLE: itemsTable.tableName,
        OUTPUT_BUCKET: outputBucket.bucketName
      },
      reservedConcurrentExecutions: 1,
    });
    //Layer
    s3BatchProcessor.addLayers(helperLayer)
    //Permissions
    itemsTable.grantReadWriteData(s3BatchProcessor)
    s3BatchProcessor.grantInvoke(s3BatchOperationsRole)
    s3BatchOperationsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:*"],
        resources: ["*"]
      })
    );
    //------------------------------------------------------------

    // Item processor (Router to Sync/Async Pipeline)
    const itemProcessor = new lambda.Function(this, 'TaskProcessor', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/itemprocessor'),
      handler: 'lambda_function.lambda_handler',
      timeout: cdk.Duration.seconds(900),
      environment: {
        SYNC_QUEUE_URL: syncJobsQueue.queueUrl,
        ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl
      }
    });
    //Layer
    itemProcessor.addLayers(helperLayer)
    //Trigger
    itemProcessor.addEventSource(new DynamoEventSource(itemsTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON
    }));

    //Permissions
    itemsTable.grantReadWriteData(itemProcessor)
    syncJobsQueue.grantSendMessages(itemProcessor)
    asyncJobsQueue.grantSendMessages(itemProcessor)

    //------------------------------------------------------------

    // Sync Jobs Processor (Process jobs using sync APIs)
    const syncProcessor = new lambda.Function(this, 'SyncProcessor', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/syncprocessor'),
      handler: 'lambda_function.lambda_handler',
      reservedConcurrentExecutions: 1,
      timeout: cdk.Duration.seconds(25),
      environment: {
        OUTPUT_BUCKET: outputBucket.bucketName,
        ITEMS_TABLE: itemsTable.tableName,
        AWS_DATA_PATH : "models"
      }
    });
    //Layer
    syncProcessor.addLayers(helperLayer)
    //Trigger
    syncProcessor.addEventSource(new SqsEventSource(syncJobsQueue, {
      batchSize: 1
    }));
    //Permissions
    contentBucket.grantReadWrite(syncProcessor)
    existingContentBucket.grantReadWrite(syncProcessor)
    outputBucket.grantReadWrite(syncProcessor)
    itemsTable.grantReadWriteData(syncProcessor)
    syncProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["rekognition:*"],
        resources: ["*"]
      })
    );

    //------------------------------------------------------------

    // Async Job Processor (Start jobs using Async APIs)
    const asyncProcessor = new lambda.Function(this, 'ASyncProcessor', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/asyncprocessor'),
      handler: 'lambda_function.lambda_handler',
      reservedConcurrentExecutions: 1,
      timeout: cdk.Duration.seconds(60),
      environment: {
        ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl,
        SNS_TOPIC_ARN : jobCompletionTopic.topicArn,
        SNS_ROLE_ARN : rekognitionServiceRole.roleArn,
        AWS_DATA_PATH : "models"
      }
    });

    //Layer
    asyncProcessor.addLayers(helperLayer)
    //Triggers
    // Run async job processor every 5 minutes
    //Enable code below after test deploy
     const rule = new events.Rule(this, 'Rule', {
       schedule: events.Schedule.expression('rate(2 minutes)')
     });
     rule.addTarget(new LambdaFunction(asyncProcessor));

    //Run when a job is successfully complete
    asyncProcessor.addEventSource(new SnsEventSource(jobCompletionTopic))
    //Permissions
    contentBucket.grantRead(asyncProcessor)
    existingContentBucket.grantReadWrite(asyncProcessor)
    asyncJobsQueue.grantConsumeMessages(asyncProcessor)
    asyncProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [rekognitionServiceRole.roleArn]
      })
    );
    asyncProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["rekognition:*"],
        resources: ["*"]
      })
    );
    //------------------------------------------------------------

    // Async Jobs Results Processor
    const jobResultProcessor = new lambda.Function(this, 'JobResultProcessor', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/jobresultprocessor'),
      handler: 'lambda_function.lambda_handler',
      memorySize: 2000,
      reservedConcurrentExecutions: 50,
      timeout: cdk.Duration.seconds(900),
      environment: {
        OUTPUT_BUCKET: outputBucket.bucketName,
        ITEMS_TABLE: itemsTable.tableName,
        AWS_DATA_PATH : "models"
      }
    });
    //Layer
    jobResultProcessor.addLayers(helperLayer)
    //Triggers
    jobResultProcessor.addEventSource(new SqsEventSource(jobResultsQueue, {
      batchSize: 1
    }));
    //Permissions
    outputBucket.grantReadWrite(jobResultProcessor)
    itemsTable.grantReadWriteData(jobResultProcessor)
    contentBucket.grantReadWrite(jobResultProcessor)
    existingContentBucket.grantReadWrite(jobResultProcessor)
    jobResultProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["rekognition:*"],
        resources: ["*"]
      })
    );

    //--------------
    // S3 folders creator

    const s3FolderCreator = new lambda.Function(this, 's3FolderCreator', {
      code: lambda.Code.fromAsset('lambda/s3FolderCreator'),
      description: 'Creates folders in S3 bucket for different Rekognition APIs',
      handler: 'index.lambda_handler',
      timeout: cdk.Duration.seconds(60),
      runtime: lambda.Runtime.PYTHON_3_9,
      environment: {
          CONTENT_BUCKET: contentBucket.bucketName,
          EXISTING_CONTENT_BUCKET: existingContentBucket.bucketName,
      }
    });
    contentBucket.grantReadWrite(s3FolderCreator)
    existingContentBucket.grantReadWrite(s3FolderCreator)
    s3FolderCreator.node.addDependency(contentBucket)
    s3FolderCreator.node.addDependency(existingContentBucket)

    

  }
}
