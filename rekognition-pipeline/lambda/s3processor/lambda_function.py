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

    print("Input Object: {}/{}".format(bucketName, objectName))

    ext = FileHelper.getFileExtenstion(objectName.lower())
    print("Extension: {}".format(ext))

    if(ext and ext in ["jpg", "jpeg", "png", "mov", "mp4"]):
        itemId = str(uuid.uuid1())
        ds = datastore.ItemStore(itemsTable)
        ds.createItem(itemId, bucketName, objectName)

        output = "Saved item {} for {}/{}".format(itemId, bucketName, objectName)

        print(output)

    return {
        'statusCode': 200,
        'body': json.dumps(output)
    }

def lambda_handler(event, context):

    print("event: {}".format(event))

    request = {}
    request["bucketName"] = event['Records'][0]['s3']['bucket']['name']
    request["objectName"] = urllib.parse.unquote_plus(event['Records'][0]['s3']['object']['key'])
    request["itemsTable"] = os.environ['ITEMS_TABLE']
    request["outputBucket"] = os.environ['OUTPUT_BUCKET']

    return processRequest(request)
