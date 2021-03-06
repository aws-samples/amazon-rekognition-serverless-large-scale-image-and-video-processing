import json
import os
import uuid
import urllib
import datastore
from helper import FileHelper

def processRequest(request):

    output = ""

    print("request: {}".format(request))

    bucketName = request["bucketName"]
    objectName = request["objectName"]
    itemsTable = request["itemsTable"]
    outputBucket = request["outputBucket"]

    jobId = request["jobId"]
    invocationId = request['invocationId']
    invocationSchemaVersion = request['invocationSchemaVersion']
    taskId = request['taskId']

    print("Input Object: {}/{}".format(bucketName, objectName))

    ext = FileHelper.getFileExtenstion(objectName.lower())
    print("Extension: {}".format(ext))

    if(ext and ext in ["jpg", "jpeg", "png", "mov", "mp4"]):
        itemId = str(uuid.uuid1())
        ds = datastore.ItemStore(itemsTable)
        ds.createItem(itemId, bucketName, objectName)

        output = "Saved item {} for {}/{}".format(itemId, bucketName, objectName)

        print(output)

    results = [{
        'taskId': taskId,
        'resultCode': 'Succeeded',
        'resultString': "Item submitted for processing with Id: {}".format(itemId)
    }]
    
    return {
        'invocationSchemaVersion': invocationSchemaVersion,
        'treatMissingKeysAs': 'PermanentFailure',
        'invocationId': invocationId,
        'results': results
    }

def lambda_handler(event, context):

    print("event: {}".format(event))

    request = {}

    # Parse job parameters
    request["jobId"] = event['job']['id']
    request["invocationId"] = event['invocationId']
    request["invocationSchemaVersion"] = event['invocationSchemaVersion']

    # Task
    request["task"] = event['tasks'][0]
    request["taskId"] = event['tasks'][0]['taskId']
    request["objectName"] = urllib.parse.unquote_plus(event['tasks'][0]['s3Key'])
    request["s3VersionId"] = event['tasks'][0]['s3VersionId']
    request["s3BucketArn"] = event['tasks'][0]['s3BucketArn']
    request["bucketName"] = request["s3BucketArn"].split(':')[-1]

    request["itemsTable"] = os.environ['ITEMS_TABLE']
    request["outputBucket"] = os.environ['OUTPUT_BUCKET']

    return processRequest(request)

