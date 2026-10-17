// The VST 3 interface ids the host uses. The headers only declare each
// interface's `iid`; coreiids.cpp defines the base ones, this the rest.

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstattributes.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/ivstpluginterfacesupport.h"
#include "pluginterfaces/vst/ivstunits.h"

namespace Steinberg
{
DEF_CLASS_IID (IPlugView)
namespace Vst
{
DEF_CLASS_IID (IComponent)
DEF_CLASS_IID (IAudioProcessor)
DEF_CLASS_IID (IAudioPresentationLatency)
DEF_CLASS_IID (IProcessContextRequirements)
DEF_CLASS_IID (IEditController)
DEF_CLASS_IID (IEditController2)
DEF_CLASS_IID (IComponentHandler)
DEF_CLASS_IID (IComponentHandler2)
DEF_CLASS_IID (IParameterChanges)
DEF_CLASS_IID (IParamValueQueue)
DEF_CLASS_IID (IHostApplication)
DEF_CLASS_IID (IMessage)
DEF_CLASS_IID (IAttributeList)
DEF_CLASS_IID (IConnectionPoint)
DEF_CLASS_IID (IPlugInterfaceSupport)
DEF_CLASS_IID (IUnitInfo)
} // namespace Vst
} // namespace Steinberg
