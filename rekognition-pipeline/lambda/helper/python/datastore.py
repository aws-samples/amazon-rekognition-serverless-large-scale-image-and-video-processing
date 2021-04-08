import boto3
from botocore.exceptions import ClientError
from helper import AwsHelper
import  datetime

class ItemStore:

    def __init__(self, itemsTableName):
        self._itemsTableName = itemsTableName

    def createItem(self, itemId, bucketName, objectName):

        err = None

        dynamodb = AwsHelper().getResource("dynamodb")
        table = dynamodb.Table(self._itemsTableName)

        try:
            table.update_item(
                Key = { "itemId": itemId },
                UpdateExpression = 'SET bucketName = :bucketNameValue, objectName = :objectNameValue, itemStatus = :itemstatusValue, itemCreatedOn = :itemCreatedOnValue',
                ConditionExpression = 'attribute_not_exists(itemId)',
                ExpressionAttributeValues = {
                    ':bucketNameValue': bucketName,
                    ':objectNameValue': objectName,
                    ':itemstatusValue': 'IN_PROGRESS',
                    ':itemCreatedOnValue': str(datetime.datetime.utcnow())
                }
            )
        except ClientError as e:
            print(e)
            if e.response['Error']['Code'] == "ConditionalCheckFailedException":
                print(e.response['Error']['Message'])
                err  = {'Error' : 'Item already exist.'}
            else:
                raise

        return err

    def updateItemStatus(self, itemId, itemStatus):

        err = None

        dynamodb = AwsHelper().getResource("dynamodb")
        table = dynamodb.Table(self._itemsTableName)

        try:
            table.update_item(
                Key = { 'itemId': itemId },
                UpdateExpression = 'SET itemStatus= :itemstatusValue',
                ConditionExpression = 'attribute_exists(itemId)',
                ExpressionAttributeValues = {
                    ':itemstatusValue': itemStatus
                }
            )
        except ClientError as e:
            if e.response['Error']['Code'] == "ConditionalCheckFailedException":
                print(e.response['Error']['Message'])
                err  = {'Error' : 'Item does not exist.'}
            else:
                raise

        return err

    def markItemComplete(self, itemId):

        err = None

        dynamodb = AwsHelper().getResource("dynamodb")
        table = dynamodb.Table(self._itemsTableName)

        try:
            table.update_item(
                Key = { 'itemId': itemId },
                UpdateExpression = 'SET itemStatus= :itemstatusValue, itemCompletedOn = :itemCompletedOnValue',
                ConditionExpression = 'attribute_exists(itemId)',
                ExpressionAttributeValues = {
                    ':itemstatusValue': "SUCCEEDED",
                    ':itemCompletedOnValue': str(datetime.datetime.utcnow())
                }
            )
        except ClientError as e:
            if e.response['Error']['Code'] == "ConditionalCheckFailedException":
                print(e.response['Error']['Message'])
                err  = {'Error' : 'Item does not exist.'}
            else:
                raise

        return err

    def getItem(self, itemId):

        dynamodb = AwsHelper().getClient("dynamodb")

        ddbGetItemResponse = dynamodb.get_item(
            Key={'itemId': {'S': itemId} },
            TableName=self._itemsTableName
        )

        itemToReturn = None

        if('Item' in ddbGetItemResponse):
            itemToReturn = { 'itemId' : ddbGetItemResponse['Item']['itemId']['S'],
                             'bucketName' : ddbGetItemResponse['Item']['bucketName']['S'],
                             'objectName' : ddbGetItemResponse['Item']['objectName']['S'],
                             'itemStatus' : ddbGetItemResponse['Item']['itemStatus']['S'] }

        return itemToReturn

    def deleteItem(self, itemId):

        dynamodb = AwsHelper().getResource("dynamodb")
        table = dynamodb.Table(self._itemsTableName)

        table.delete_item(
            Key={
                'itemId': itemId
            }
        )

    def getItems(self, nextToken=None):

        dynamodb = AwsHelper().getResource("dynamodb")
        table = dynamodb.Table(self._itemsTableName)

        pageSize = 25

        if(nextToken):
            response = table.scan(ExclusiveStartKey={ "itemId" : nextToken}, Limit=pageSize)
        else:
            response = table.scan(Limit=pageSize)

        print("response: {}".format(response))

        data = []

        if('Items' in response):        
            data = response['Items']

        items = { 
            "items" : data
        }

        if 'LastEvaluatedKey' in response:
            nextToken = response['LastEvaluatedKey']['itemId']
            print("nexToken: {}".format(nextToken))
            items["nextToken"] = nextToken

        return items