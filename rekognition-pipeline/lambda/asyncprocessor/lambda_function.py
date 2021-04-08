import json
import boto3
import os
from helper import AwsHelper
import time

def startJob(bucketName, objectName, itemId, snsTopic, snsRole, apiName):

    print("Starting job with itemId: {}, bucketName: {}, objectName: {}".format(itemId, bucketName, objectName))

    response = None
    client = AwsHelper().getClient('rekognition')
    
    if(apiName == "labels"):
        response = client.start_label_detection(
            Video={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            },
            ClientRequestToken = itemId,
            NotificationChannel={
                'SNSTopicArn': snsTopic,
                'RoleArn': snsRole
            },
            JobTag=itemId
        )
    elif(apiName == "text"):
        response = client.start_text_detection(
            Video={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            },
            ClientRequestToken = itemId,
            NotificationChannel={
                'SNSTopicArn': snsTopic,
                'RoleArn': snsRole
            },
            JobTag=itemId
        )
    elif(apiName == "faces"):
        response = client.start_face_detection(
            Video={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            },
            ClientRequestToken = itemId,
            NotificationChannel={
                'SNSTopicArn': snsTopic,
                'RoleArn': snsRole
            },
            JobTag=itemId
        )
    elif(apiName == "moderation"):
        response = client.start_content_moderation(
            Video={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            },
            ClientRequestToken = itemId,
            NotificationChannel={
                'SNSTopicArn': snsTopic,
                'RoleArn': snsRole
            },
            JobTag=itemId
        )
    elif(apiName == "celebrities"):
        response = client.start_celebrity_recognition(
            Video={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            },
            ClientRequestToken = itemId,
            NotificationChannel={
                'SNSTopicArn': snsTopic,
                'RoleArn': snsRole
            },
            JobTag=itemId
        )
    else:
        response = client.start_label_detection(
            Video={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            },
            ClientRequestToken = itemId,
            NotificationChannel={
                'SNSTopicArn': snsTopic,
                'RoleArn': snsRole
            },
            JobTag=itemId
        )
    return response["JobId"]


def processItem(message, snsTopic, snsRole):

    print('message:')
    print(message)

    messageBody = json.loads(message['Body'])

    bucketName = messageBody['bucketName']
    objectName = messageBody['objectName']
    itemId = messageBody['itemId']
    apiName = objectName.split("/")[0]

    print('Bucket Name: ' + bucketName)
    print('Object Name: ' + objectName)
    print('Task ID: ' + itemId)

    print('starting Rekognition job...')

    jobId = startJob(bucketName, objectName, itemId, snsTopic, snsRole, apiName)

    if(jobId):
        print("Started Job with Id: {}".format(jobId))

    return jobId

def changeVisibility(sqs, qUrl, receipt_handle):
    try:
        sqs.change_message_visibility(
                QueueUrl=qUrl,
                ReceiptHandle=receipt_handle,
                VisibilityTimeout=0
            )
    except Exception as e:
        print("Failed to change visibility for {} with error: {}".format(receipt_handle, e))

def getMessagesFromQueue(sqs, qUrl,):
    # Receive message from SQS queue
    response = sqs.receive_message(
        QueueUrl=qUrl,
        MaxNumberOfMessages=1,
        VisibilityTimeout=60 #14400
    )

    print('SQS Response Received:')
    print(response)

    if('Messages' in response):
        return response['Messages']
    else:
        print("No messages in queue.")
        return None

def processItems(qUrl, snsTopic, snsRole):

    sqs = AwsHelper().getClient('sqs')
    messages = getMessagesFromQueue(sqs, qUrl)

    jc = 0
    totalMessages = 0
    hitLimit = False
    limitException = None

    if(messages):


        totalMessages = len(messages)
        print("Total messages: {}".format(totalMessages))

        for message in messages:
            receipt_handle = message['ReceiptHandle']

            try:
                if(hitLimit):
                    changeVisibility(sqs, qUrl, receipt_handle)
                else:
                    print("starting job...")
                    processItem(message, snsTopic, snsRole)
                    print("started job...")
                    print('Deleting item from queue...')
                    # Delete received message from queue
                    sqs.delete_message(
                        QueueUrl=qUrl,
                        ReceiptHandle=receipt_handle
                    )
                    print('Deleted item from queue...')
                    jc += 1
            except Exception as e:
                print("Error while starting job or deleting from queue: {}".format(e))
                changeVisibility(sqs, qUrl, receipt_handle)
                if(e.__class__.__name__ == 'LimitExceededException' 
                    or e.__class__.__name__ == "ProvisionedThroughputExceededException"):
                    hitLimit = True
                    limitException = e

        if(hitLimit):
            raise limitException()

    return totalMessages, jc

def processRequest(request):

    qUrl = request['qUrl']
    snsTopic = request['snsTopic']
    snsRole = request['snsRole']

    i = 0
    max = 100

    totalJobsScheduled = 0

    hitLimit = False
    provisionedThroughputExceededCount = 0

    while(i < max):
        try:
            tc, jc = processItems(qUrl, snsTopic, snsRole)

            totalJobsScheduled += jc

            if(tc == 0):
                i = max

        except Exception as e:
            if(e.__class__.__name__ == 'LimitExceededException'):
                print("Exception: Hit limit.")
                hitLimit = True
                i = max
            elif(e.__class__.__name__ == "ProvisionedThroughputExceededException"):
                print("ProvisionedThroughputExceededException.")
                provisionedThroughputExceededCount += 1
                if(provisionedThroughputExceededCount > 5):
                    i = max
                else:
                    print("Waiting for few seconds...")
                    time.sleep(5)
                    print("Waking up...")

        i += 1

    output = "Started {} jobs.".format(totalJobsScheduled)
    if(hitLimit):
        output += " Hit limit."

    print(output)

    return {
        'statusCode': 200,
        'body': output
    }

def lambda_handler(event, context):

    print("event: {}".format(event))

    request = {}

    request["qUrl"] = os.environ['ASYNC_QUEUE_URL']
    request["snsTopic"] = os.environ['SNS_TOPIC_ARN']
    request["snsRole"] = os.environ['SNS_ROLE_ARN']

    return processRequest(request)

