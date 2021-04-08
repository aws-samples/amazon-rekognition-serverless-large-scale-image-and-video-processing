import json
import os
from helper import FileHelper, AwsHelper

def postMessage(client, qUrl, jsonMessage):

    message = json.dumps(jsonMessage)

    response = client.send_message(
        QueueUrl=qUrl,
        MessageBody=message
    )

    print("Submitted message to queue: {}".format(message))
    return response

def processRequest(request):

    output = ""

    print("request: {}".format(request))

    itemId = request["itemId"]
    bucketName = request["bucketName"]
    objectName = request["objectName"]

    print("Input Object: {}/{}".format(bucketName, objectName))

    ext = FileHelper.getFileExtenstion(objectName.lower())
    print("Extension: {}".format(ext))

    if(ext and ext in ["jpg", "jpeg", "png"]):
        qUrl = request['syncQueueUrl']
    elif (ext in ["mov", "mp4"]):
        qUrl = request['asyncQueueUrl']

    if(qUrl):
        jsonMessage = { 'itemId' : itemId,
            'bucketName': bucketName,
            'objectName' : objectName }

        client = AwsHelper().getClient('sqs')
        response = postMessage(client, qUrl, jsonMessage)

    output = "Completed routing for itemId: {}, object: {}/{}".format(itemId, bucketName, objectName)

    print(output)
    return response

def processRecord(record, syncQueueUrl, asyncQueueUrl):
    
    newImage = record["dynamodb"]["NewImage"]
    
    itemId = None
    bucketName = None
    objectName = None
    itemStatus = None
    
    if("itemId" in newImage and "S" in newImage["itemId"]):
        itemId = newImage["itemId"]["S"]
    if("bucketName" in newImage and "S" in newImage["bucketName"]):
        bucketName = newImage["bucketName"]["S"]
    if("objectName" in newImage and "S" in newImage["objectName"]):
        objectName = newImage["objectName"]["S"]
    if("itemStatus" in newImage and "S" in newImage["itemStatus"]):
        itemStatus = newImage["itemStatus"]["S"]

    print("ItemId: {}, BucketName: {}, ObjectName: {}, ItemStatus: {}".format(itemId, bucketName, objectName, itemStatus))

    if(itemId and bucketName and objectName and itemStatus):
        request = {}
        request["itemId"] = itemId
        request["bucketName"] = bucketName
        request["objectName"] = objectName
        request['syncQueueUrl'] = syncQueueUrl
        request['asyncQueueUrl'] = asyncQueueUrl

        response = processRequest(request)
        return response

def lambda_handler(event, context):

    try: 
        print("event: {}".format(event))

        syncQueueUrl = os.environ['SYNC_QUEUE_URL']
        asyncQueueUrl = os.environ['ASYNC_QUEUE_URL']

        if("Records" in event and event["Records"]):
            for record in event["Records"]:
                try:
                    print("Processing record: {}".format(record))

                    if("eventName" in record and record["eventName"] == "INSERT"):
                        if("dynamodb" in record and record["dynamodb"] and "NewImage" in record["dynamodb"]):
                            response = processRecord(record, syncQueueUrl, asyncQueueUrl)
                            #print ("message: {}". format(json.dumps(response)))

                except Exception as e:
                    print("Failed to process record. Exception: {}".format(e))

    except Exception as e:
        print("Failed to process records. Exception: {}".format(e))
