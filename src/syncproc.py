import boto3
from decimal import Decimal
import json
import os
from helper import AwsHelper, S3Helper, DynamoDBHelper
import datastore

def callRekognition(bucketName, objectName, apiName):
    rekognition = AwsHelper().getClient('rekognition')
    
    if(apiName == "labels"):
        response = rekognition.detect_labels(
            Image={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            }
        )
    elif (apiName == "text"):
        response = rekognition.detect_text(
            Image={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            }
        )
    elif (apiName == "faces"):
        response = rekognition.detect_faces(
            Image={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            }
        )
    elif (apiName == "moderation"):
        response = rekognition.detect_moderation_labels(
            Image={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            }
        )
    elif (apiName == "celebrities"):
        response = rekognition.recognize_celebrities(
            Image={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            }
        )
    else:
        response = rekognition.detect_labels(
            Image={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            }
        )
    return response


def processImage(itemId, bucketName, objectName, outputBucketName, itemsTableName):

    
    apiName = objectName.split("/")[0]

    response = callRekognition(bucketName, objectName, apiName)

    print("Generating output for ItemId: {}".format(itemId))
    print(response)

    outputPath = "sync/{}-analysis/{}/".format(objectName, itemId)
    opath = "{}response.json".format(outputPath)
    S3Helper.writeToS3(json.dumps(response), outputBucketName, opath)

    #opg = OutputGenerator(itemId, response, bucketName, objectName, detectForms, detectTables, ddb)
    #opg.run()

    print("ItemId: {}".format(itemId))

    ds = datastore.ItemStore(itemsTableName)
    ds.markItemComplete(itemId)

# --------------- Main handler ------------------

def processRequest(request):

    output = ""

    print("request: {}".format(request))

    bucketName = request['bucketName']
    objectName = request['objectName']
    itemId = request['itemId']
    outputBucket = request['outputBucket']
    itemsTable = request['itemsTable']
    itemsTable = request["itemsTable"]
    
    if(itemId and bucketName and objectName):
        print("ItemId: {}, Object: {}/{}".format(itemId, bucketName, objectName))

        processImage(itemId, bucketName, objectName, outputBucket, itemsTable)

        output = "Item: {}, Object: {}/{} processed.".format(itemId, bucketName, objectName)
        print(output)

    return {
        'statusCode': 200,
        'body': output
    }

def lambda_handler(event, context):

    print("event: {}".format(event))
    message = json.loads(event['Records'][0]['body'])
    print("Message: {}".format(message))

    request = {}
    request["itemId"] = message['itemId']
    request["bucketName"] = message['bucketName']
    request["objectName"] = message['objectName']
    request["outputBucket"] = os.environ['OUTPUT_BUCKET']
    request["itemsTable"] = os.environ['ITEMS_TABLE']

    return processRequest(request)
