"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("@aws-cdk/core");
const cfn = require("@aws-cdk/aws-cloudformation");
const events = require("@aws-cdk/aws-events");
const iam = require("@aws-cdk/aws-iam");
const aws_lambda_event_sources_1 = require("@aws-cdk/aws-lambda-event-sources");
const sns = require("@aws-cdk/aws-sns");
const snsSubscriptions = require("@aws-cdk/aws-sns-subscriptions");
const sqs = require("@aws-cdk/aws-sqs");
const dynamodb = require("@aws-cdk/aws-dynamodb");
const lambda = require("@aws-cdk/aws-lambda");
const s3 = require("@aws-cdk/aws-s3");
const aws_events_targets_1 = require("@aws-cdk/aws-events-targets");
const fs = require("fs");
class RekognitionPipelineStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, Object.assign({}, props, {
            description: "Process images and videos at scale using Amazon Rekognition (uksb-1sd4nlm88)"
        }));
        // The code that defines your stack goes here
        //**********SNS Topics******************************
        const jobCompletionTopic = new sns.Topic(this, 'JobCompletion');
        //**********IAM Roles******************************
        const rekognitionServiceRole = new iam.Role(this, 'RekognitionServiceRole', {
            assumedBy: new iam.ServicePrincipal('rekognition.amazonaws.com')
        });
        rekognitionServiceRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: [jobCompletionTopic.topicArn],
            actions: ["sns:Publish"]
        }));
        //**********S3 Batch Operations Role******************************
        const s3BatchOperationsRole = new iam.Role(this, 'S3BatchOperationsRole', {
            assumedBy: new iam.ServicePrincipal('batchoperations.s3.amazonaws.com')
        });
        //**********S3 Bucket******************************
        //S3 bucket for input items and output
        const contentBucket = new s3.Bucket(this, 'ContentBucket', { versioned: false });
        const existingContentBucket = new s3.Bucket(this, 'ExistingContentBucket', { versioned: false });
        existingContentBucket.grantReadWrite(s3BatchOperationsRole);
        const inventoryAndLogsBucket = new s3.Bucket(this, 'InventoryAndLogsBucket', { versioned: false });
        inventoryAndLogsBucket.grantReadWrite(s3BatchOperationsRole);
        const outputBucket = new s3.Bucket(this, 'OutputBucket', { versioned: false });
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
            visibilityTimeout: cdk.Duration.seconds(30), retentionPeriod: cdk.Duration.seconds(1209600), deadLetterQueue: { queue: dlq, maxReceiveCount: 50 }
        });
        //Input Queue for async jobs
        const asyncJobsQueue = new sqs.Queue(this, 'AsyncJobs', {
            visibilityTimeout: cdk.Duration.seconds(30), retentionPeriod: cdk.Duration.seconds(1209600), deadLetterQueue: { queue: dlq, maxReceiveCount: 50 }
        });
        //Queue
        const jobResultsQueue = new sqs.Queue(this, 'JobResults', {
            visibilityTimeout: cdk.Duration.seconds(900), retentionPeriod: cdk.Duration.seconds(1209600), deadLetterQueue: { queue: dlq, maxReceiveCount: 50 }
        });
        //Trigger
        jobCompletionTopic.addSubscription(new snsSubscriptions.SqsSubscription(jobResultsQueue));
        //**********Lambda Functions******************************
        // Helper Layer with helper functions
        const helperLayer = new lambda.LayerVersion(this, 'HelperLayer', {
            code: lambda.Code.fromAsset('lambda/helper'),
            compatibleRuntimes: [lambda.Runtime.PYTHON_3_7],
            license: 'Apache-2.0',
            description: 'Helper layer.',
        });
        //------------------------------------------------------------
        // S3 Event processor
        const s3Processor = new lambda.Function(this, 'S3Processor', {
            runtime: lambda.Runtime.PYTHON_3_7,
            code: lambda.Code.asset('lambda/s3processor'),
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
        s3Processor.addLayers(helperLayer);
        //Trigger
        s3Processor.addEventSource(new aws_lambda_event_sources_1.S3EventSource(contentBucket, {
            events: [s3.EventType.OBJECT_CREATED],
            filters: [{ suffix: '.mov' }]
        }));
        s3Processor.addEventSource(new aws_lambda_event_sources_1.S3EventSource(contentBucket, {
            events: [s3.EventType.OBJECT_CREATED],
            filters: [{ suffix: '.mp4' }]
        }));
        s3Processor.addEventSource(new aws_lambda_event_sources_1.S3EventSource(contentBucket, {
            events: [s3.EventType.OBJECT_CREATED],
            filters: [{ suffix: '.png' }]
        }));
        s3Processor.addEventSource(new aws_lambda_event_sources_1.S3EventSource(contentBucket, {
            events: [s3.EventType.OBJECT_CREATED],
            filters: [{ suffix: '.jpg' }]
        }));
        s3Processor.addEventSource(new aws_lambda_event_sources_1.S3EventSource(contentBucket, {
            events: [s3.EventType.OBJECT_CREATED],
            filters: [{ suffix: '.jpeg' }]
        }));
        //Permissions
        itemsTable.grantReadWriteData(s3Processor);
        syncJobsQueue.grantSendMessages(s3Processor);
        asyncJobsQueue.grantSendMessages(s3Processor);
        //------------------------------------------------------------
        // S3 Batch Operations Event processor 
        const s3BatchProcessor = new lambda.Function(this, 'S3BatchProcessor', {
            runtime: lambda.Runtime.PYTHON_3_7,
            code: lambda.Code.asset('lambda/s3batchprocessor'),
            handler: 'lambda_function.lambda_handler',
            timeout: cdk.Duration.seconds(30),
            environment: {
                ITEMS_TABLE: itemsTable.tableName,
                OUTPUT_BUCKET: outputBucket.bucketName
            },
            reservedConcurrentExecutions: 1,
        });
        //Layer
        s3BatchProcessor.addLayers(helperLayer);
        //Permissions
        itemsTable.grantReadWriteData(s3BatchProcessor);
        s3BatchProcessor.grantInvoke(s3BatchOperationsRole);
        s3BatchOperationsRole.addToPolicy(new iam.PolicyStatement({
            actions: ["lambda:*"],
            resources: ["*"]
        }));
        //------------------------------------------------------------
        // Item processor (Router to Sync/Async Pipeline)
        const itemProcessor = new lambda.Function(this, 'TaskProcessor', {
            runtime: lambda.Runtime.PYTHON_3_7,
            code: lambda.Code.asset('lambda/itemprocessor'),
            handler: 'lambda_function.lambda_handler',
            timeout: cdk.Duration.seconds(900),
            environment: {
                SYNC_QUEUE_URL: syncJobsQueue.queueUrl,
                ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl
            }
        });
        //Layer
        itemProcessor.addLayers(helperLayer);
        //Trigger
        itemProcessor.addEventSource(new aws_lambda_event_sources_1.DynamoEventSource(itemsTable, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON
        }));
        //Permissions
        itemsTable.grantReadWriteData(itemProcessor);
        syncJobsQueue.grantSendMessages(itemProcessor);
        asyncJobsQueue.grantSendMessages(itemProcessor);
        //------------------------------------------------------------
        // Sync Jobs Processor (Process jobs using sync APIs)
        const syncProcessor = new lambda.Function(this, 'SyncProcessor', {
            runtime: lambda.Runtime.PYTHON_3_7,
            code: lambda.Code.asset('lambda/syncprocessor'),
            handler: 'lambda_function.lambda_handler',
            reservedConcurrentExecutions: 1,
            timeout: cdk.Duration.seconds(25),
            environment: {
                OUTPUT_BUCKET: outputBucket.bucketName,
                ITEMS_TABLE: itemsTable.tableName,
                AWS_DATA_PATH: "models"
            }
        });
        //Layer
        syncProcessor.addLayers(helperLayer);
        //Trigger
        syncProcessor.addEventSource(new aws_lambda_event_sources_1.SqsEventSource(syncJobsQueue, {
            batchSize: 1
        }));
        //Permissions
        contentBucket.grantReadWrite(syncProcessor);
        existingContentBucket.grantReadWrite(syncProcessor);
        outputBucket.grantReadWrite(syncProcessor);
        itemsTable.grantReadWriteData(syncProcessor);
        syncProcessor.addToRolePolicy(new iam.PolicyStatement({
            actions: ["rekognition:*"],
            resources: ["*"]
        }));
        //------------------------------------------------------------
        // Async Job Processor (Start jobs using Async APIs)
        const asyncProcessor = new lambda.Function(this, 'ASyncProcessor', {
            runtime: lambda.Runtime.PYTHON_3_7,
            code: lambda.Code.asset('lambda/asyncprocessor'),
            handler: 'lambda_function.lambda_handler',
            reservedConcurrentExecutions: 1,
            timeout: cdk.Duration.seconds(60),
            environment: {
                ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl,
                SNS_TOPIC_ARN: jobCompletionTopic.topicArn,
                SNS_ROLE_ARN: rekognitionServiceRole.roleArn,
                AWS_DATA_PATH: "models"
            }
        });
        //Layer
        asyncProcessor.addLayers(helperLayer);
        //Triggers
        // Run async job processor every 5 minutes
        //Enable code below after test deploy
        const rule = new events.Rule(this, 'Rule', {
            schedule: events.Schedule.expression('rate(2 minutes)')
        });
        rule.addTarget(new aws_events_targets_1.LambdaFunction(asyncProcessor));
        //Run when a job is successfully complete
        asyncProcessor.addEventSource(new aws_lambda_event_sources_1.SnsEventSource(jobCompletionTopic));
        //Permissions
        contentBucket.grantRead(asyncProcessor);
        existingContentBucket.grantReadWrite(asyncProcessor);
        asyncJobsQueue.grantConsumeMessages(asyncProcessor);
        asyncProcessor.addToRolePolicy(new iam.PolicyStatement({
            actions: ["iam:PassRole"],
            resources: [rekognitionServiceRole.roleArn]
        }));
        asyncProcessor.addToRolePolicy(new iam.PolicyStatement({
            actions: ["rekognition:*"],
            resources: ["*"]
        }));
        //------------------------------------------------------------
        // Async Jobs Results Processor
        const jobResultProcessor = new lambda.Function(this, 'JobResultProcessor', {
            runtime: lambda.Runtime.PYTHON_3_7,
            code: lambda.Code.asset('lambda/jobresultprocessor'),
            handler: 'lambda_function.lambda_handler',
            memorySize: 2000,
            reservedConcurrentExecutions: 50,
            timeout: cdk.Duration.seconds(900),
            environment: {
                OUTPUT_BUCKET: outputBucket.bucketName,
                ITEMS_TABLE: itemsTable.tableName,
                AWS_DATA_PATH: "models"
            }
        });
        //Layer
        jobResultProcessor.addLayers(helperLayer);
        //Triggers
        jobResultProcessor.addEventSource(new aws_lambda_event_sources_1.SqsEventSource(jobResultsQueue, {
            batchSize: 1
        }));
        //Permissions
        outputBucket.grantReadWrite(jobResultProcessor);
        itemsTable.grantReadWriteData(jobResultProcessor);
        contentBucket.grantReadWrite(jobResultProcessor);
        existingContentBucket.grantReadWrite(jobResultProcessor);
        jobResultProcessor.addToRolePolicy(new iam.PolicyStatement({
            actions: ["rekognition:*"],
            resources: ["*"]
        }));
        //--------------
        // S3 folders creator
        const s3FolderCreator = new lambda.SingletonFunction(this, 's3FolderCreator', {
            uuid: 'f7d4f730-4ee1-11e8-9c2d-fa7ae01bbebc',
            code: new lambda.InlineCode(fs.readFileSync('lambda/s3FolderCreator/lambda_function.py', { encoding: 'utf-8' })),
            description: 'Creates folders in S3 bucket for different Rekognition APIs',
            handler: 'index.lambda_handler',
            timeout: cdk.Duration.seconds(60),
            runtime: lambda.Runtime.PYTHON_3_7,
            environment: {
                CONTENT_BUCKET: contentBucket.bucketName,
                EXISTING_CONTENT_BUCKET: existingContentBucket.bucketName,
            }
        });
        contentBucket.grantReadWrite(s3FolderCreator);
        existingContentBucket.grantReadWrite(s3FolderCreator);
        s3FolderCreator.node.addDependency(contentBucket);
        s3FolderCreator.node.addDependency(existingContentBucket);
        const resource = new cfn.CustomResource(this, 'Resource', {
            provider: cfn.CustomResourceProvider.lambda(s3FolderCreator)
        });
    }
}
exports.RekognitionPipelineStack = RekognitionPipelineStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVrb2duaXRpb24tcGlwZWxpbmUtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyZWtvZ25pdGlvbi1waXBlbGluZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLHFDQUFxQztBQUNyQyxtREFBb0Q7QUFDcEQsOENBQStDO0FBQy9DLHdDQUF5QztBQUN6QyxnRkFBcUg7QUFDckgsd0NBQXlDO0FBQ3pDLG1FQUFvRTtBQUNwRSx3Q0FBeUM7QUFDekMsa0RBQW1EO0FBQ25ELDhDQUErQztBQUMvQyxzQ0FBdUM7QUFDdkMsb0VBQTJEO0FBQzNELHlCQUF5QjtBQUV6QixNQUFhLHdCQUF5QixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQ3JELFlBQVksS0FBb0IsRUFBRSxFQUFVLEVBQUUsS0FBc0I7UUFDbEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFFLEVBQUUsS0FBSyxFQUFFO1lBQ3hDLFdBQVcsRUFBRSw4RUFBOEU7U0FDNUYsQ0FBQyxDQUFDLENBQUM7UUFFSiw2Q0FBNkM7UUFFN0Msb0RBQW9EO1FBQ3BELE1BQU0sa0JBQWtCLEdBQUcsSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxlQUFlLENBQUMsQ0FBQztRQUVoRSxtREFBbUQ7UUFDbkQsTUFBTSxzQkFBc0IsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLHdCQUF3QixFQUFFO1lBQzFFLFNBQVMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQywyQkFBMkIsQ0FBQztTQUNqRSxDQUFDLENBQUM7UUFDSCxzQkFBc0IsQ0FBQyxXQUFXLENBQ2hDLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQ3hCLFNBQVMsRUFBRSxDQUFDLGtCQUFrQixDQUFDLFFBQVEsQ0FBQztZQUN4QyxPQUFP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QWEsRUFBRSxZQUFZLENBQUMsVUFBVTthQUN2QztTQUNGLENBQUMsQ0FBQztRQUNILE9BQU87UUFDUCxXQUFXLENBQUMsU0FBUyxDQUFDLFdBQVcsQ0FBQyxDQUFBO1FBQ2xDLFNBQVM7UUFDVCxXQUFXLENBQUMsY0FBYyxDQUFDLElBQUksd0NBQWEsQ0FBQyxhQUFhLEVBQUU7WUFDMUQsTUFBTSxFQUFFLENBQUUsRUFBRSxDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUU7WUFDdkMsT0FBTyxFQUFFLENBQUUsRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLENBQUM7U0FDL0IsQ0FBQyxDQUFDLENBQUM7UUFDSixXQUFXLENBQUMsY0FBYyxDQUFDLElBQUksd0NBQWEsQ0FBQyxhQUFhLEVBQUU7WUFDMUQsTUFBTSxFQUFFLENBQUUsRUFBRSxDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUU7WUFDdkMsT0FBTyxFQUFFLENBQUUsRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLENBQUM7U0FDL0IsQ0FBQyxDQUFDLENBQUM7UUFDSixXQUFXLENBQUMsY0FBYyxDQUFDLElBQUksd0NBQWEsQ0FBQyxhQUFhLEVBQUU7WUFDMUQsTUFBTSxFQUFFLENBQUUsRUFBRSxDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUU7WUFDdkMsT0FBTyxFQUFFLENBQUUsRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLENBQUM7U0FDL0IsQ0FBQyxDQUFDLENBQUM7UUFDSixXQUFXLENBQUMsY0FBYyxDQUFDLElBQUksd0NBQWEsQ0FBQyxhQUFhLEVBQUU7WUFDMUQsTUFBTSxFQUFFLENBQUUsRUFBRSxDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUU7WUFDdkMsT0FBTyxFQUFFLENBQUUsRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLENBQUM7U0FDL0IsQ0FBQyxDQUFDLENBQUM7UUFDSixXQUFXLENBQUMsY0FBYyxDQUFDLElBQUksd0NBQWEsQ0FBQyxhQUFhLEVBQUU7WUFDMUQsTUFBTSxFQUFFLENBQUUsRUFBRSxDQUFDLFNBQVMsQ0FBQyxjQUFjLENB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O1NBQzdELENBQUMsQ0FBQztJQUVMLENBQUM7Q0FDRjtBQXpURCw0REF5VEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnQGF3cy1jZGsvY29yZSc7XG5pbXBvcnQgY2ZuID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLWNsb3VkZm9ybWF0aW9uJyk7XG5pbXBvcnQgZXZlbnRzID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLWV2ZW50cycpO1xuaW1wb3J0IGlhbSA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1pYW0nKTtcbmltcG9ydCB7IFMzRXZlbnRTb3VyY2UsIFNxc0V2ZW50U291cmNlLCBTbnNFdmVudFNvdXJjZSwgRHluYW1vRXZlbnRTb3VyY2UgfSBmcm9tICdAYXdzLWNkay9hd3MtbGFtYmRhLWV2ZW50LXNvdXJjZXMnO1xuaW1wb3J0IHNucyA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1zbnMnKTtcbmltcG9ydCBzbnNTdWJzY3JpcHRpb25zID0gcmVxdWlyZShcIkBhd3MtY2RrL2F3cy1zbnMtc3Vic2NyaXB0aW9uc1wiKTtcbmltcG9ydCBzcXMgPSByZXF1aXJlKCdAYXdzLWNkay9hd3Mtc3FzJyk7XG5pbXBvcnQgZHluYW1vZGIgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtZHluYW1vZGInKTtcbmltcG9ydCBsYW1iZGEgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtbGFtYmRhJyk7XG5pbXBvcnQgczMgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtczMnKTtcbmltcG9ydCB7TGFtYmRhRnVuY3Rpb259IGZyb20gXCJAYXdzLWNkay9hd3MtZXZlbnRzLXRhcmdldHNcIjtcbmltcG9ydCAqIGFzIGZzIGZyb20gJ2ZzJztcblxuZXhwb3J0IGNsYXNzIFJla29nbml0aW9uUGlwZWxpbmVTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBjZGsuQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBPYmplY3QuYXNzaWduKHt9LCBwcm9wcywge1xuICAgICAgZGVzY3JpcHRpb246IFwiUHJvY2VzcyBpbWFnZXMgYW5kIHZpZGVvcyBhdCBzY2FsZSB1c2luZyBBbWF6b24gUmVrb2duaXRpb24gKHVrc2ItMXNkNG5sbTg4KVwiXG4gICAgfSkpO1xuXG4gICAgLy8gVGhlIGNvZGUgdGhhdCBkZWZpbmVzIHlvdXIgc3RhY2sgZ29lcyBoZXJlXG4gICAgXG4gICAgLy8qKioqKioqKioqU05TIFRvcGljcyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKlxuICAgIGNvbnN0IGpvYkNvbXBsZXRpb25Ub3BpYyA9IG5ldyBzbnMuVG9waWModGhpcywgJ0pvYkNvbXBsZXRpb24nKTtcblxuICAgIC8vKioqKioqKioqKklBTSBSb2xlcyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKlxuICAgIGNvbnN0IHJla29nbml0aW9uU2VydmljZVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1Jla29nbml0aW9uU2VydmljZVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgncmVrb2duaXRpb24uYW1hem9uYXdzLmNvbScpXG4gICAgfSk7XG4gICAgcmVrb2duaXRpb25TZXJ2aWNlUm9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICByZXNvdXJjZXM6IFtqb2JDb21wbGV0aW9uVG9waWMudG9waWNBcm5dLFxuICAgICAgICBhY3Rpb25zOiBbXCJzbnM6UHVibGlzaFwiXVxuICAgICAgfSlcbiAgICApO1xuXG5cbiAgICAvLyoqKioqKioqKipTMyBCYXRjaCBPcGVyYXRpb25zIFJvbGUqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcbiAgICBjb25zdCBzM0JhdGNoT3BlcmF0aW9uc1JvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1MzQmF0Y2hPcGVyYXRpb25zUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiYXRjaG9wZXJhdGlvbnMuczMuYW1hem9uYXdzLmNvbScpXG4gICAgfSk7XG5cbiAgICAvLyoqKioqKioqKipTMyBCdWNrZXQqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcbiAgICAvL1MzIGJ1Y2tldCBmb3IgaW5wdXQgaXRlbXMgYW5kIG91dHB1dFxuICAgIGNvbnN0IGNvbnRlbnRCdWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdDb250ZW50QnVja2V0Jywge3ZlcnNpb25lZDogZmFsc2V9KTtcblxuICAgIGNvbnN0IGV4aXN0aW5nQ29udGVudEJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ0V4aXN0aW5nQ29udGVudEJ1Y2tldCcsIHt2ZXJzaW9uZWQ6IGZhbHNlfSk7XG4gICAgZXhpc3RpbmdDb250ZW50QnVja2V0LmdyYW50UmVhZFdyaXRlKHMzQmF0Y2hPcGVyYXRpb25zUm9sZSlcblxuICAgIGNvbnN0IGludmVudG9yeUFuZExvZ3NCdWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdJbnZlbnRvcnlBbmRMb2dzQnVja2V0Jywge3ZlcnNpb25lZDogZmFsc2V9KTtcbiAgICBpbnZlbnRvcnlBbmRMb2dzQnVja2V0LmdyYW50UmVhZFdyaXRlKHMzQmF0Y2hPcGVyYXRpb25zUm9sZSlcblxuICAgIGNvbnN0IG91dHB1dEJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ091dHB1dEJ1Y2tldCcsIHt2ZXJzaW9uZWQ6IGZhbHNlfSk7XG5cbiAgICAvLyoqKioqKioqKipEeW5hbW9EQiBUYWJsZSoqKioqKioqKioqKioqKioqKioqKioqKipcbiAgICAvL0R5bmFtb0RCIHRhYmxlIHdpdGggbGlua3MgdG8gb3V0cHV0IGluIFMzXG4gICAgY29uc3QgaXRlbXNUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCAnSXRlbXNUYWJsZScsIHtcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnaXRlbUlkJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHN0cmVhbTogZHluYW1vZGIuU3RyZWFtVmlld1R5cGUuTkVXX0lNQUdFXG4gICAgfSk7XG5cbiAgICAvLyoqKioqKioqKipTUVMgUXVldWVzKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcbiAgICAvL0RMUVxuICAgIGNvbnN0IGRscSA9IG5ldyBzcXMuUXVldWUodGhpcywgJ0RMUScsIHtcbiAgICAgIHZpc2liaWxpdHlUaW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksIHJldGVudGlvblBlcmlvZDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTIwOTYwMClcbiAgICB9KTtcblxuICAgIC8vSW5wdXQgUXVldWUgZm9yIHN5bmMgam9ic1xuICAgIGNvbnN0IHN5bmNKb2JzUXVldWUgPSBuZXcgc3FzLlF1ZXVlKHRoaXMsICdTeW5jSm9icycsIHtcbiAgICAgIHZpc2liaWxpdHlUaW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksIHJldGVudGlvblBlcmlvZDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTIwOTYwMCksIGRlYWRMZXR0ZXJRdWV1ZSA6IHsgcXVldWU6IGRscSwgbWF4UmVjZWl2ZUNvdW50OiA1MH1cbiAgICB9KTtcblxuICAgIC8vSW5wdXQgUXVldWUgZm9yIGFzeW5jIGpvYnNcbiAgICBjb25zdCBhc3luY0pvYnNRdWV1ZSA9IG5ldyBzcXMuUXVldWUodGhpcywgJ0FzeW5jSm9icycsIHtcbiAgICAgIHZpc2liaWxpdHlUaW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksIHJldGVudGlvblBlcmlvZDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTIwOTYwMCksIGRlYWRMZXR0ZXJRdWV1ZSA6IHsgcXVldWU6IGRscSwgbWF4UmVjZWl2ZUNvdW50OiA1MH1cbiAgICB9KTtcblxuICAgIC8vUXVldWVcbiAgICBjb25zdCBqb2JSZXN1bHRzUXVldWUgPSBuZXcgc3FzLlF1ZXVlKHRoaXMsICdKb2JSZXN1bHRzJywge1xuICAgICAgdmlzaWJpbGl0eVRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDkwMCksIHJldGVudGlvblBlcmlvZDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTIwOTYwMCksIGRlYWRMZXR0ZXJRdWV1ZSA6IHsgcXVldWU6IGRscSwgbWF4UmVjZWl2ZUNvdW50OiA1MH1cbiAgICB9KTtcbiAgICAvL1RyaWdnZXJcbiAgICBqb2JDb21wbGV0aW9uVG9waWMuYWRkU3Vic2NyaXB0aW9uKFxuICAgICAgbmV3IHNuc1N1YnNjcmlwdGlvbnMuU3FzU3Vic2NyaXB0aW9uKGpvYlJlc3VsdHNRdWV1ZSlcbiAgICApO1xuXG4gICAgLy8qKioqKioqKioqTGFtYmRhIEZ1bmN0aW9ucyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKlxuXG4gICAgLy8gSGVscGVyIExheWVyIHdpdGggaGVscGVyIGZ1bmN0aW9uc1xuICAgIGNvbnN0IGhlbHBlckxheWVyID0gbmV3IGxhbWJkYS5MYXllclZlcnNpb24odGhpcywgJ0hlbHBlckxheWVyJywge1xuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KCdsYW1iZGEvaGVscGVyJyksXG4gICAgICBjb21wYXRpYmxlUnVudGltZXM6IFtsYW1iZGEuUnVudGltZS5QWVRIT05fM183XSxcbiAgICAgIGxpY2Vuc2U6ICdBcGFjaGUtMi4wJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnSGVscGVyIGxheWVyLicsXG4gICAgfSk7XG5cbiAgICAvLy0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgLy8gUzMgRXZlbnQgcHJvY2Vzc29yXG4gICAgY29uc3QgczNQcm9jZXNzb3IgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdTM1Byb2Nlc3NvcicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzcsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL3MzcHJvY2Vzc29yJyksXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFNZTkNfUVVFVUVfVVJMOiBzeW5jSm9ic1F1ZXVlLnF1ZXVlVXJsLFxuICAgICAgICBBU1lOQ19RVUVVRV9VUkw6IGFzeW5jSm9ic1F1ZXVlLnF1ZXVlVXJsLFxuICAgICAgICBJVEVNU19UQUJMRTogaXRlbXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIE9VVFBVVF9CVUNLRVQ6IG91dHB1dEJ1Y2tldC5idWNrZXROYW1lXG4gICAgICB9XG4gICAgfSk7XG4gICAgLy9MYXllclxuICAgIHMzUHJvY2Vzc29yLmFkZExheWVycyhoZWxwZXJMYXllcilcbiAgICAvL1RyaWdnZXJcbiAgICBzM1Byb2Nlc3Nvci5hZGRFdmVudFNvdXJjZShuZXcgUzNFdmVudFNvdXJjZShjb250ZW50QnVja2V0LCB7XG4gICAgICBldmVudHM6IFsgczMuRXZlbnRUeXBlLk9CSkVDVF9DUkVBVEVEIF0sICBcbiAgICAgIGZpbHRlcnM6IFsgeyBzdWZmaXg6ICcubW92JyB9XSAgXG4gICAgfSkpOyAgXG4gICAgczNQcm9jZXNzb3IuYWRkRXZlbnRTb3VyY2UobmV3IFMzRXZlbnRTb3VyY2UoY29udGVudEJ1Y2tldCwgeyBcbiAgICAgIGV2ZW50czogWyBzMy5FdmVudFR5cGUuT0JKRUNUX0NSRUFURUQgXSwgIFxuICAgICAgZmlsdGVyczogWyB7IHN1ZmZpeDogJy5tcDQnIH1dICBcbiAgICB9KSk7XG4gICAgczNQcm9jZXNzb3IuYWRkRXZlbnRTb3VyY2UobmV3IFMzRXZlbnRTb3VyY2UoY29udGVudEJ1Y2tldCwgeyBcbiAgICAgIGV2ZW50czogWyBzMy5FdmVudFR5cGUuT0JKRUNUX0NSRUFURUQgXSwgIFxuICAgICAgZmlsdGVyczogWyB7IHN1ZmZpeDogJy5wbmcnIH1dICBcbiAgICB9KSk7ICBcbiAgICBzM1Byb2Nlc3Nvci5hZGRFdmVudFNvdXJjZShuZXcgUzNFdmVudFNvdXJjZShjb250ZW50QnVja2V0LCB7IFxuICAgICAgZXZlbnRzOiBbIHMzLkV2ZW50VHlwZS5PQkpFQ1RfQ1JFQVRFRCBdLCAgXG4gICAgICBmaWx0ZXJzOiBbIHsgc3VmZml4OiAnLmpwZycgfV0gIFxuICAgIH0pKTsgIFxuICAgIHMzUHJvY2Vzc29yLmFkZEV2ZW50U291cmNlKG5ldyBTM0V2ZW50U291cmNlKGNvbnRlbnRCdWNrZXQsIHsgXG4gICAgICBldmVudHM6IFsgczMuRXZlbnRUeXBlLk9CSkVDVF9DUkVBVEVEIF0sICBcbiAgICAgIGZpbHRlcnM6IFsgeyBzdWZmaXg6ICcuanBlZycgfV1cbiAgICB9KSk7XG4gICAgLy9QZXJtaXNzaW9uc1xuICAgIGl0ZW1zVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHMzUHJvY2Vzc29yKVxuICAgIHN5bmNKb2JzUXVldWUuZ3JhbnRTZW5kTWVzc2FnZXMoczNQcm9jZXNzb3IpXG4gICAgYXN5bmNKb2JzUXVldWUuZ3JhbnRTZW5kTWVzc2FnZXMoczNQcm9jZXNzb3IpXG5cbiAgICAvLy0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgLy8gUzMgQmF0Y2ggT3BlcmF0aW9ucyBFdmVudCBwcm9jZXNzb3IgXG4gICAgY29uc3QgczNCYXRjaFByb2Nlc3NvciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ1MzQmF0Y2hQcm9jZXNzb3InLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM183LFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuYXNzZXQoJ2xhbWJkYS9zM2JhdGNocHJvY2Vzc29yJyksXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIElURU1TX1RBQkxFOiBpdGVtc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgT1VUUFVUX0JVQ0tFVDogb3V0cHV0QnVja2V0LmJ1Y2tldE5hbWVcbiAgICAgIH0sXG4gICAgICByZXNlcnZlZENvbmN1cnJlbnRFeGVjdXRpb25zOiAxLFxuICAgIH0pO1xuICAgIC8vTGF5ZXJcbiAgICBzM0JhdGNoUHJvY2Vzc29yLmFkZExheWVycyhoZWxwZXJMYXllcilcbiAgICAvL1Blcm1pc3Npb25zXG4gICAgaXRlbXNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoczNCYXRjaFByb2Nlc3NvcilcbiAgICBzM0JhdGNoUHJvY2Vzc29yLmdyYW50SW52b2tlKHMzQmF0Y2hPcGVyYXRpb25zUm9sZSlcbiAgICBzM0JhdGNoT3BlcmF0aW9uc1JvbGUuYWRkVG9Qb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcImxhbWJkYToqXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl1cbiAgICAgIH0pXG4gICAgKTtcbiAgICAvLy0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgLy8gSXRlbSBwcm9jZXNzb3IgKFJvdXRlciB0byBTeW5jL0FzeW5jIFBpcGVsaW5lKVxuICAgIGNvbnN0IGl0ZW1Qcm9jZXNzb3IgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdUYXNrUHJvY2Vzc29yJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfNyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmFzc2V0KCdsYW1iZGEvaXRlbXByb2Nlc3NvcicpLFxuICAgICAgaGFuZGxlcjogJ2xhbWJkYV9mdW5jdGlvbi5sYW1iZGFfaGFuZGxlcicsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg5MDApLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgU1lOQ19RVUVVRV9VUkw6IHN5bmNKb2JzUXVldWUucXVldWVVcmwsXG4gICAgICAgIEFTWU5DX1FVRVVFX1VSTDogYXN5bmNKb2JzUXVldWUucXVldWVVcmxcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvL0xheWVyXG4gICAgaXRlbVByb2Nlc3Nvci5hZGRMYXllcnMoaGVscGVyTGF5ZXIpXG4gICAgLy9UcmlnZ2VyXG4gICAgaXRlbVByb2Nlc3Nvci5hZGRFdmVudFNvdXJjZShuZXcgRHluYW1vRXZlbnRTb3VyY2UoaXRlbXNUYWJsZSwge1xuICAgICAgc3RhcnRpbmdQb3NpdGlvbjogbGFtYmRhLlN0YXJ0aW5nUG9zaXRpb24uVFJJTV9IT1JJWk9OXG4gICAgfSkpO1xuXG4gICAgLy9QZXJtaXNzaW9uc1xuICAgIGl0ZW1zVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGl0ZW1Qcm9jZXNzb3IpXG4gICAgc3luY0pvYnNRdWV1ZS5ncmFudFNlbmRNZXNzYWdlcyhpdGVtUHJvY2Vzc29yKVxuICAgIGFzeW5jSm9ic1F1ZXVlLmdyYW50U2VuZE1lc3NhZ2VzKGl0ZW1Qcm9jZXNzb3IpXG5cbiAgICAvLy0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gICAgLy8gU3luYyBKb2JzIFByb2Nlc3NvciAoUHJvY2VzcyBqb2JzIHVzaW5nIHN5bmMgQVBJcylcbiAgICBjb25zdCBzeW5jUHJvY2Vzc29yID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnU3luY1Byb2Nlc3NvcicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzcsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL3N5bmNwcm9jZXNzb3InKSxcbiAgICAgIGhhbmRsZXI6ICdsYW1iZGFfZnVuY3Rpb24ubGFtYmRhX2hhbmRsZXInLFxuICAgICAgcmVzZXJ2ZWRDb25jdXJyZW50RXhlY3V0aW9uczogMSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDI1KSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIE9VVFBVVF9CVUNLRVQ6IG91dHB1dEJ1Y2tldC5idWNrZXROYW1lLFxuICAgICAgICBJVEVNU19UQUJMRTogaXRlbXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEFXU19EQVRBX1BBVEggOiBcIm1vZGVsc1wiXG4gICAgICB9XG4gICAgfSk7XG4gICAgLy9MYXllclxuICAgIHN5bmNQcm9jZXNzb3IuYWRkTGF5ZXJzKGhlbHBlckxheWVyKVxuICAgIC8vVHJpZ2dlclxuICAgIHN5bmNQcm9jZXNzb3IuYWRkRXZlbnRTb3VyY2UobmV3IFNxc0V2ZW50U291cmNlKHN5bmNKb2JzUXVldWUsIHtcbiAgICAgIGJhdGNoU2l6ZTogMVxuICAgIH0pKTtcbiAgICAvL1Blcm1pc3Npb25zXG4gICAgY29udGVudEJ1Y2tldC5ncmFudFJlYWRXcml0ZShzeW5jUHJvY2Vzc29yKVxuICAgIGV4aXN0aW5nQ29udGVudEJ1Y2tldC5ncmFudFJlYWRXcml0ZShzeW5jUHJvY2Vzc29yKVxuICAgIG91dHB1dEJ1Y2tldC5ncmFudFJlYWRXcml0ZShzeW5jUHJvY2Vzc29yKVxuICAgIGl0ZW1zVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHN5bmNQcm9jZXNzb3IpXG4gICAgc3luY1Byb2Nlc3Nvci5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcInJla29nbml0aW9uOipcIl0sXG4gICAgICAgIHJlc291cmNlczogW1wiKlwiXVxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8vIEFzeW5jIEpvYiBQcm9jZXNzb3IgKFN0YXJ0IGpvYnMgdXNpbmcgQXN5bmMgQVBJcylcbiAgICBjb25zdCBhc3luY1Byb2Nlc3NvciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0FTeW5jUHJvY2Vzc29yJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfNyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmFzc2V0KCdsYW1iZGEvYXN5bmNwcm9jZXNzb3InKSxcbiAgICAgIGhhbmRsZXI6ICdsYW1iZGFfZnVuY3Rpb24ubGFtYmRhX2hhbmRsZXInLFxuICAgICAgcmVzZXJ2ZWRDb25jdXJyZW50RXhlY3V0aW9uczogMSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIEFTWU5DX1FVRVVFX1VSTDogYXN5bmNKb2JzUXVldWUucXVldWVVcmwsXG4gICAgICAgIFNOU19UT1BJQ19BUk4gOiBqb2JDb21wbGV0aW9uVG9waWMudG9waWNBcm4sXG4gICAgICAgIFNOU19ST0xFX0FSTiA6IHJla29nbml0aW9uU2VydmljZVJvbGUucm9sZUFybixcbiAgICAgICAgQVdTX0RBVEFfUEFUSCA6IFwibW9kZWxzXCJcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vTGF5ZXJcbiAgICBhc3luY1Byb2Nlc3Nvci5hZGRMYXllcnMoaGVscGVyTGF5ZXIpXG4gICAgLy9UcmlnZ2Vyc1xuICAgIC8vIFJ1biBhc3luYyBqb2IgcHJvY2Vzc29yIGV2ZXJ5IDUgbWludXRlc1xuICAgIC8vRW5hYmxlIGNvZGUgYmVsb3cgYWZ0ZXIgdGVzdCBkZXBsb3lcbiAgICAgY29uc3QgcnVsZSA9IG5ldyBldmVudHMuUnVsZSh0aGlzLCAnUnVsZScsIHtcbiAgICAgICBzY2hlZHVsZTogZXZlbnRzLlNjaGVkdWxlLmV4cHJlc3Npb24oJ3JhdGUoMiBtaW51dGVzKScpXG4gICAgIH0pO1xuICAgICBydWxlLmFkZFRhcmdldChuZXcgTGFtYmRhRnVuY3Rpb24oYXN5bmNQcm9jZXNzb3IpKTtcblxuICAgIC8vUnVuIHdoZW4gYSBqb2IgaXMgc3VjY2Vzc2Z1bGx5IGNvbXBsZXRlXG4gICAgYXN5bmNQcm9jZXNzb3IuYWRkRXZlbnRTb3VyY2UobmV3IFNuc0V2ZW50U291cmNlKGpvYkNvbXBsZXRpb25Ub3BpYykpXG4gICAgLy9QZXJtaXNzaW9uc1xuICAgIGNvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkKGFzeW5jUHJvY2Vzc29yKVxuICAgIGV4aXN0aW5nQ29udGVudEJ1Y2tldC5ncmFudFJlYWRXcml0ZShhc3luY1Byb2Nlc3NvcilcbiAgICBhc3luY0pvYnNRdWV1ZS5ncmFudENvbnN1bWVNZXNzYWdlcyhhc3luY1Byb2Nlc3NvcilcbiAgICBhc3luY1Byb2Nlc3Nvci5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcImlhbTpQYXNzUm9sZVwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbcmVrb2duaXRpb25TZXJ2aWNlUm9sZS5yb2xlQXJuXVxuICAgICAgfSlcbiAgICApO1xuICAgIGFzeW5jUHJvY2Vzc29yLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wicmVrb2duaXRpb246KlwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdXG4gICAgICB9KVxuICAgICk7XG4gICAgLy8tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAgIC8vIEFzeW5jIEpvYnMgUmVzdWx0cyBQcm9jZXNzb3JcbiAgICBjb25zdCBqb2JSZXN1bHRQcm9jZXNzb3IgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdKb2JSZXN1bHRQcm9jZXNzb3InLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM183LFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuYXNzZXQoJ2xhbWJkYS9qb2JyZXN1bHRwcm9jZXNzb3InKSxcbiAgICAgIGhhbmRsZXI6ICdsYW1iZGFfZnVuY3Rpb24ubGFtYmRhX2hhbmRsZXInLFxuICAgICAgbWVtb3J5U2l6ZTogMjAwMCxcbiAgICAgIHJlc2VydmVkQ29uY3VycmVudEV4ZWN1dGlvbnM6IDUwLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoOTAwKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIE9VVFBVVF9CVUNLRVQ6IG91dHB1dEJ1Y2tldC5idWNrZXROYW1lLFxuICAgICAgICBJVEVNU19UQUJMRTogaXRlbXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEFXU19EQVRBX1BBVEggOiBcIm1vZGVsc1wiXG4gICAgICB9XG4gICAgfSk7XG4gICAgLy9MYXllclxuICAgIGpvYlJlc3VsdFByb2Nlc3Nvci5hZGRMYXllcnMoaGVscGVyTGF5ZXIpXG4gICAgLy9UcmlnZ2Vyc1xuICAgIGpvYlJlc3VsdFByb2Nlc3Nvci5hZGRFdmVudFNvdXJjZShuZXcgU3FzRXZlbnRTb3VyY2Uoam9iUmVzdWx0c1F1ZXVlLCB7XG4gICAgICBiYXRjaFNpemU6IDFcbiAgICB9KSk7XG4gICAgLy9QZXJtaXNzaW9uc1xuICAgIG91dHB1dEJ1Y2tldC5ncmFudFJlYWRXcml0ZShqb2JSZXN1bHRQcm9jZXNzb3IpXG4gICAgaXRlbXNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoam9iUmVzdWx0UHJvY2Vzc29yKVxuICAgIGNvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoam9iUmVzdWx0UHJvY2Vzc29yKVxuICAgIGV4aXN0aW5nQ29udGVudEJ1Y2tldC5ncmFudFJlYWRXcml0ZShqb2JSZXN1bHRQcm9jZXNzb3IpXG4gICAgam9iUmVzdWx0UHJvY2Vzc29yLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wicmVrb2duaXRpb246KlwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLy0tLS0tLS0tLS0tLS0tXG4gICAgLy8gUzMgZm9sZGVycyBjcmVhdG9yXG5cbiAgICBjb25zdCBzM0ZvbGRlckNyZWF0b3IgPSBuZXcgbGFtYmRhLlNpbmdsZXRvbkZ1bmN0aW9uKHRoaXMsICdzM0ZvbGRlckNyZWF0b3InLCB7XG4gICAgICB1dWlkOiAnZjdkNGY3MzAtNGVlMS0xMWU4LTljMmQtZmE3YWUwMWJiZWJjJyxcbiAgICAgIGNvZGU6IG5ldyBsYW1iZGEuSW5saW5lQ29kZShmcy5yZWFkRmlsZVN5bmMoJ2xhbWJkYS9zM0ZvbGRlckNyZWF0b3IvbGFtYmRhX2Z1bmN0aW9uLnB5JywgeyBlbmNvZGluZzogJ3V0Zi04JyB9KSksXG4gICAgICBkZXNjcmlwdGlvbjogJ0NyZWF0ZXMgZm9sZGVycyBpbiBTMyBidWNrZXQgZm9yIGRpZmZlcmVudCBSZWtvZ25pdGlvbiBBUElzJyxcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5sYW1iZGFfaGFuZGxlcicsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM183LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgICBDT05URU5UX0JVQ0tFVDogY29udGVudEJ1Y2tldC5idWNrZXROYW1lLFxuICAgICAgICAgIEVYSVNUSU5HX0NPTlRFTlRfQlVDS0VUOiBleGlzdGluZ0NvbnRlbnRCdWNrZXQuYnVja2V0TmFtZSxcbiAgICAgIH1cbiAgICB9KTtcbiAgICBjb250ZW50QnVja2V0LmdyYW50UmVhZFdyaXRlKHMzRm9sZGVyQ3JlYXRvcilcbiAgICBleGlzdGluZ0NvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoczNGb2xkZXJDcmVhdG9yKVxuICAgIHMzRm9sZGVyQ3JlYXRvci5ub2RlLmFkZERlcGVuZGVuY3koY29udGVudEJ1Y2tldClcbiAgICBzM0ZvbGRlckNyZWF0b3Iubm9kZS5hZGREZXBlbmRlbmN5KGV4aXN0aW5nQ29udGVudEJ1Y2tldClcblxuICAgIGNvbnN0IHJlc291cmNlID0gbmV3IGNmbi5DdXN0b21SZXNvdXJjZSh0aGlzLCAnUmVzb3VyY2UnLCB7XG4gICAgICBwcm92aWRlcjogY2ZuLkN1c3RvbVJlc291cmNlUHJvdmlkZXIubGFtYmRhKHMzRm9sZGVyQ3JlYXRvcilcbiAgICB9KTtcblxuICB9XG59XG4iXX0=